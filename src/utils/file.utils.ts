// src/utils/file.utils.ts
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

/**
 * Calcula SHA256 hash de un archivo
 */
export function sha256(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Detecta MIME type por extensión de archivo
 */
export function guessMimeByExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'application/octet-stream';
}

/**
 * Obtiene tamaño del archivo de forma segura (retorna null si no existe)
 */
export function safeStatSize(filePath?: string | null): number | null {
  try {
    if (!filePath) return null;
    if (!fs.existsSync(filePath)) return null;
    const st = fs.statSync(filePath);
    return st.size ?? null;
  } catch {
    return null;
  }
}

/**
 * Verifica si un archivo existe
 */
export function fileExists(filePath?: string | null): boolean {
  if (!filePath) return false;
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}
