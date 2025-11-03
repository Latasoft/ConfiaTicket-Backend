// src/services/qrExtractor.service.ts
import sharp from 'sharp';
import jsQR from 'jsqr';
import fs from 'fs/promises';

/**
 * Extrae el código QR de una imagen
 * Soporta: PDF (primera página como imagen), PNG, JPEG
 * 
 * @param filePath - Ruta al archivo de imagen
 * @returns El contenido del QR como string, o null si no se encuentra
 */
export async function extractQrFromImage(filePath: string): Promise<string | null> {
  try {
    // Leer el archivo
    const fileBuffer = await fs.readFile(filePath);
    
    // Convertir la imagen a formato raw (RGBA)
    // Sharp convierte el archivo (incluso PDFs) a imagen
    const image = sharp(fileBuffer);
    const metadata = await image.metadata();
    
    // Redimensionar si es muy grande para mejorar performance
    const maxDimension = 2000;
    let processedImage = image;
    
    if (metadata.width && metadata.width > maxDimension || 
        metadata.height && metadata.height > maxDimension) {
      processedImage = image.resize(maxDimension, maxDimension, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    
    // Convertir a raw RGBA buffer
    const { data, info } = await processedImage
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    // jsQR espera Uint8ClampedArray
    const imageData = new Uint8ClampedArray(data);
    
    // Intentar decodificar el QR
    const qrCode = jsQR(imageData, info.width, info.height);
    
    if (qrCode && qrCode.data) {
      console.log('QR extraído exitosamente:', qrCode.data.substring(0, 50) + '...');
      return qrCode.data;
    }
    
    // Si no se encontró, intentar con diferentes transformaciones
    console.log('QR no encontrado, intentando transformaciones...');
    
    // Intentar con escala de grises y mayor contraste
    const enhancedImage = await sharp(fileBuffer)
      .greyscale()
      .normalize()
      .resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    const enhancedImageData = new Uint8ClampedArray(enhancedImage.data);
    const qrCodeEnhanced = jsQR(enhancedImageData, enhancedImage.info.width, enhancedImage.info.height);
    
    if (qrCodeEnhanced && qrCodeEnhanced.data) {
      console.log('QR extraído con transformaciones:', qrCodeEnhanced.data.substring(0, 50) + '...');
      return qrCodeEnhanced.data;
    }
    
    console.log('No se pudo extraer QR de la imagen');
    return null;
    
  } catch (error) {
    console.error('Error al extraer QR:', error);
    return null;
  }
}

/**
 * Valida si un string parece ser un código QR válido
 * (básicamente, verifica que no esté vacío y tenga contenido útil)
 */
export function isValidQrCode(qrData: string | null): boolean {
  if (!qrData) return false;
  
  // Verificar que tenga contenido
  if (qrData.trim().length === 0) return false;
  
  // Verificar longitud mínima razonable (QR típicos tienen al menos algunos caracteres)
  if (qrData.length < 3) return false;
  
  return true;
}

/**
 * Extrae y valida el QR de una imagen de ticket
 * Retorna el código QR o lanza un error descriptivo
 */
export async function extractAndValidateQr(filePath: string): Promise<string> {
  const qrCode = await extractQrFromImage(filePath);
  
  if (!isValidQrCode(qrCode)) {
    throw new Error('No se pudo extraer un código QR válido de la imagen del ticket');
  }
  
  return qrCode!;
}
