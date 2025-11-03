// src/services/resaleTicketPdf.service.ts
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';

interface ResaleTicketData {
  eventName: string;
  eventDate: Date;
  eventLocation: string;
  eventCity?: string | null;
  eventCommune?: string | null;
  buyerName: string;
  buyerEmail: string;
  ticketCode: string;      // Código del ticket original
  row: string;             // Fila del asiento
  seat: string;            // Asiento
  zone?: string | null;    // Zona
  level?: string | null;   // Nivel
  proxyQrCode: string;     // UUID del QR proxy
  reservationCode: string;
  totalAmount: number;
  priceBase?: number | null; // Precio base original del ticket
}

const UPLOADS_BASE = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(process.cwd(), 'uploads');

const PDF_DIR = path.join(UPLOADS_BASE, 'private', 'tickets', 'resale');
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

/**
 * Genera un PDF con el ticket para eventos RESALE
 * Incluye el QR proxy (no el original) y advertencias de reventa
 */
export async function generateResaleTicketPDF(ticketData: ResaleTicketData): Promise<string> {
  // Asegurar que el directorio existe
  await fsPromises.mkdir(PDF_DIR, { recursive: true });

  // Nombre del archivo
  const filename = `resale-ticket-${ticketData.proxyQrCode}.pdf`;
  const filepath = path.join(PDF_DIR, filename);

  // Generar URL del proxy QR - Apunta al FRONTEND, no al backend
  const proxyQrUrl = `${FRONTEND_URL}/resale-tickets/validate/${ticketData.proxyQrCode}`;

  // Generar imagen del código QR proxy
  const qrImageBuffer = await QRCode.toBuffer(proxyQrUrl, {
    errorCorrectionLevel: 'H',
    type: 'png',
    width: 200,
  });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 30, bottom: 30, left: 40, right: 40 },
    });

    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const leftMargin = 40;
    const rightMargin = 40;
    const contentWidth = pageWidth - leftMargin - rightMargin;

    // ===================== HEADER CON COLOR DE FONDO =====================
    let currentY = 30;
    
    // Fondo del header (color naranja/advertencia para reventa)
    doc
      .rect(0, 0, pageWidth, 90)
      .fillAndStroke('#ea580c', '#ea580c');

    // Badge de REVENTA (sin ampersand)
    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .fillColor('#fef3c7')
      .text('TICKET DE REVENTA', leftMargin, 20, {
        width: contentWidth,
        align: 'center',
      });

    // Nombre del evento en el header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .fillColor('#ffffff')
      .text(ticketData.eventName, leftMargin, 40, {
        width: contentWidth,
        align: 'center',
      });

    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor('#fed7aa')
      .text('Entrada Verificada', leftMargin, 68, {
        width: contentWidth,
        align: 'center',
      });

    // ===================== CONTENIDO PRINCIPAL =====================
    currentY = 105;

    // Layout: Datos a la izquierda, QR a la derecha
    const leftColumnX = leftMargin;
    const leftColumnWidth = contentWidth * 0.48;
    const qrColumnX = leftMargin + leftColumnWidth + 35;
    const qrSize = 170;

    // ===== COLUMNA IZQUIERDA: DATOS DEL EVENTO =====
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#1f2937');
    doc.text('Fecha del Evento:', leftColumnX, currentY);

    doc.fontSize(9).font('Helvetica').fillColor('#374151');
    const eventDateStr = new Date(ticketData.eventDate).toLocaleString('es-CL', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    doc.text(eventDateStr, leftColumnX, currentY + 12, { width: leftColumnWidth });

    currentY += 38;

    doc.fontSize(8).font('Helvetica-Bold').fillColor('#1f2937');
    doc.text('Ubicación:', leftColumnX, currentY);

    doc.fontSize(8).font('Helvetica').fillColor('#374151');
    let locationText = ticketData.eventLocation;
    if (ticketData.eventCommune && ticketData.eventCity) {
      locationText += `, ${ticketData.eventCommune}, ${ticketData.eventCity}`;
    } else if (ticketData.eventCity) {
      locationText += `, ${ticketData.eventCity}`;
    }
    doc.text(locationText, leftColumnX, currentY + 12, { width: leftColumnWidth });

    currentY += 35;

    // ===== DATOS DEL ASIENTO (DESTACADOS) =====
    const seatBoxY = currentY;
    const seatBoxHeight = 65;
    
    doc
      .roundedRect(leftColumnX, seatBoxY, leftColumnWidth, seatBoxHeight, 5)
      .fillAndStroke('#eff6ff', '#3b82f6');

    let seatY = seatBoxY + 10;

    if (ticketData.zone) {
      doc.fontSize(7).font('Helvetica-Bold').fillColor('#1e40af');
      doc.text('ZONA:', leftColumnX + 10, seatY);
      doc.fontSize(9).font('Helvetica').fillColor('#1e3a8a');
      doc.text(ticketData.zone, leftColumnX + 10, seatY + 10);
      seatY += 24;
    }

    doc.fontSize(7).font('Helvetica-Bold').fillColor('#1e40af');
    doc.text('FILA:', leftColumnX + 10, seatY);
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e3a8a');
    doc.text(ticketData.row, leftColumnX + 45, seatY - 2);

    doc.fontSize(7).font('Helvetica-Bold').fillColor('#1e40af');
    doc.text('ASIENTO:', leftColumnX + 95, seatY);
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#1e3a8a');
    doc.text(ticketData.seat, leftColumnX + 150, seatY - 2);

    currentY = seatBoxY + seatBoxHeight + 12;

    // Titular
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#1f2937');
    doc.text('Titular:', leftColumnX, currentY);
    doc.fontSize(8).font('Helvetica').fillColor('#374151');
    doc.text(ticketData.buyerName, leftColumnX, currentY + 12, { width: leftColumnWidth });

    currentY += 28;

    // Precio de Reventa
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#1f2937');
    doc.text('Precio:', leftColumnX, currentY);
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#ea580c');
    const formattedPrice = new Intl.NumberFormat('es-CL', {
      style: 'currency',
      currency: 'CLP',
      maximumFractionDigits: 0,
    }).format(ticketData.totalAmount);
    doc.text(formattedPrice, leftColumnX, currentY + 12);

    // ===== COLUMNA DERECHA: QR CODE PROXY =====
    const qrY = 105;

    // Título del QR
    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .fillColor('#dc2626')
      .text('PASO 1: VALIDACIÓN INICIAL', qrColumnX - 10, qrY, {
        width: qrSize + 20,
        align: 'center',
      });

    doc
      .fontSize(7)
      .font('Helvetica')
      .fillColor('#6b7280')
      .text('Escanea este QR al llegar', qrColumnX - 10, qrY + 14, {
        width: qrSize + 20,
        align: 'center',
      });

    // Dibujar QR proxy
    const qrImageY = qrY + 28;
    doc.image(qrImageBuffer, qrColumnX, qrImageY, { width: qrSize, height: qrSize });

    // Texto debajo del QR
    doc
      .fontSize(6)
      .font('Helvetica-Oblique')
      .fillColor('#9ca3af')
      .text(ticketData.proxyQrCode.substring(0, 18) + '...', qrColumnX - 10, qrImageY + qrSize + 5, {
        width: qrSize + 20,
        align: 'center',
      });

    // ===================== INSTRUCCIONES - MÁS COMPACTAS =====================
    // Posicionar después del contenido de la izquierda
    currentY += 30; // Espacio después del precio

    const instructionsY = currentY;
    const warningBoxHeight = 70;
    
    doc
      .roundedRect(leftMargin, instructionsY, contentWidth, warningBoxHeight, 5)
      .fillAndStroke('#fef3c7', '#f59e0b');

    currentY = instructionsY + 10;

    doc.fontSize(8).font('Helvetica-Bold').fillColor('#92400e');
    doc.text('INSTRUCCIONES DE VALIDACIÓN', leftMargin + 15, currentY, {
      width: contentWidth - 30,
      align: 'center',
    });

    currentY += 16;

    doc.fontSize(7).font('Helvetica').fillColor('#78350f');
    const instructions = [
      '1. Presenta el QR superior al personal - Se registrará tu entrada',
      '2. El personal escaneará un segundo QR en el sistema del evento',
      '3. Este ticket es válido solo para el asiento indicado',
    ];
    
    instructions.forEach((instruction) => {
      doc.text(instruction, leftMargin + 15, currentY, {
        width: contentWidth - 30,
        lineGap: 1,
      });
      currentY += 11;
    });

    // ===================== DETALLES DE LA RESERVA =====================
    currentY = instructionsY + warningBoxHeight + 12;

    doc
      .strokeColor('#e5e7eb')
      .lineWidth(0.5)
      .moveTo(leftMargin, currentY)
      .lineTo(pageWidth - rightMargin, currentY)
      .stroke();

    currentY += 10;

    const col1X = leftMargin;
    const col2X = leftMargin + contentWidth / 2;
    const colWidth = contentWidth / 2 - 10;

    doc.fontSize(7).font('Helvetica-Bold').fillColor('#6b7280');
    doc.text('CÓDIGO DE RESERVA', col1X, currentY);
    doc.fontSize(7).font('Helvetica').fillColor('#374151');
    doc.text(ticketData.reservationCode, col1X, currentY + 9);

    doc.fontSize(7).font('Helvetica-Bold').fillColor('#6b7280');
    doc.text('CÓDIGO TICKET ORIGINAL', col2X, currentY);
    doc.fontSize(7).font('Helvetica').fillColor('#374151');
    doc.text(ticketData.ticketCode, col2X, currentY + 9);

    currentY += 24;

    doc.fontSize(7).font('Helvetica-Bold').fillColor('#6b7280');
    doc.text('EMAIL', col1X, currentY);
    doc.fontSize(7).font('Helvetica').fillColor('#374151');
    doc.text(ticketData.buyerEmail, col1X, currentY + 9, { width: colWidth });

    if (ticketData.priceBase) {
      doc.fontSize(7).font('Helvetica-Bold').fillColor('#6b7280');
      doc.text('PRECIO ORIGINAL', col2X, currentY);
      doc.fontSize(7).font('Helvetica').fillColor('#374151');
      const formattedBasePrice = new Intl.NumberFormat('es-CL', {
        style: 'currency',
        currency: 'CLP',
        maximumFractionDigits: 0,
      }).format(ticketData.priceBase);
      doc.text(formattedBasePrice, col2X, currentY + 9);
    }

    // ===================== FOOTER =====================
    currentY = pageHeight - 55;

    doc
      .strokeColor('#e5e7eb')
      .lineWidth(0.5)
      .moveTo(leftMargin, currentY)
      .lineTo(pageWidth - rightMargin, currentY)
      .stroke();

    doc
      .fontSize(7)
      .font('Helvetica')
      .fillColor('#9ca3af')
      .text('ConfiaTicket - Sistema Verificado de Reventa de Entradas', leftMargin, currentY + 6, {
        width: contentWidth,
        align: 'center',
      });

    const generatedDate = new Date().toLocaleString('es-CL', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    doc.fontSize(6).fillColor('#d1d5db');
    doc.text(`Generado: ${generatedDate}`, leftMargin, currentY + 16, {
      width: contentWidth,
      align: 'center',
    });
    doc.end();

    stream.on('finish', () => {
      console.log('PDF de ticket RESALE generado:', filepath);
      resolve(filepath);
    });

    stream.on('error', (error: Error) => {
      console.error('Error al generar PDF de ticket RESALE:', error);
      reject(error);
    });
  });
}
