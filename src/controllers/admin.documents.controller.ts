// src/controllers/admin.documents.controller.ts
import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { env } from '../config/env';

const UPLOADS_BASE = env.UPLOAD_DIR
  ? path.resolve(env.UPLOAD_DIR)
  : path.join(process.cwd(), 'uploads');

/**
 * Controller para servir documentos protegidos (como la cedula de identidad)
 * Valida permisos
 * 
 * Peticion: GET /api/admin/documents/{filename}
 * Respuesta: Stream del archivo con Content-Type
 */
export async function getDocument(req: Request, res: Response, next: any) {
  try {
    // req.path contiene la ruta después del punto de montaje /api/admin/documents
    // entonces req.path será /123456-id.jpg
    let filename = req.path;
    
    // quitar el slash inicial si existe
    if (filename.startsWith('/')) {
      filename = filename.substring(1);
    }

    if (!filename) {
      return res.status(400).json({ error: 'Nombre de archivo no especificado' });
    }

    // prevenir path traversal attacks
    const normalized = path.normalize(filename).replace(/^(\.\.(\/|\\|$))+/, '');
    
    // construir la ruta completa
    const fullPath = path.join(process.cwd(), 'uploads', 'documents', normalized);

    // verificar que el archivo existe y está dentro del directorio permitido
    const allowedBase = path.join(process.cwd(), 'uploads', 'documents');
    if (!fullPath.startsWith(allowedBase)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }
    if (!fullPath.startsWith(allowedBase)) {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }
    
    // verificar que es un archivo y no un directorio
    const stats = fs.statSync(fullPath);
    if (!stats.isFile()) {
      return res.status(400).json({ error: 'Ruta inválida' });
    }

    // usar headers apropiados
    const ext = path.extname(fullPath).toLowerCase();
    const contentTypeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
    };

    const contentType = contentTypeMap[ext] || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600'); // 1 hora de cache

    // enviar el archivo
    res.sendFile(fullPath);
  } catch (err) {
    console.error('Error sirviendo documento:', err);
    res.status(500).json({ error: 'Error al obtener el documento' });
  }
}
