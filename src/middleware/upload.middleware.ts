// src/middleware/upload.middleware.ts
import path from 'path';
import fs from 'fs';
import { env } from '../config/env';

// Evitamos TS7016 usando require (tipo any)
/* eslint-disable @typescript-eslint/no-var-requires */
const multer = require('multer');

/** ====== Paths de subida (configurable por .env) ====== */
const uploadsRoot =
  env.UPLOAD_DIR && env.UPLOAD_DIR.trim().length > 0
    ? path.resolve(env.UPLOAD_DIR)
    : path.join(process.cwd(), 'uploads');

/** Subcarpetas específicas */
const uploadsDirs = {
  documents: path.join(uploadsRoot, 'documents'),
  tickets: path.join(uploadsRoot, 'tickets'),
};

// Asegura existencia de carpetas
for (const dir of Object.values(uploadsDirs)) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Genera nombres de archivo seguros y únicos */
function makeSafeFilename(original: string | undefined) {
  const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const safeOriginal = String(original || '').replace(/[^\w.\-]+/g, '_');
  return `${unique}-${safeOriginal}`;
}

/** Crea un storage de multer apuntando a una subcarpeta */
function makeStorage(subdir: keyof typeof uploadsDirs) {
  return multer.diskStorage({
    destination: (_req: any, _file: any, cb: any) => cb(null, uploadsDirs[subdir]),
    filename: (_req: any, file: any, cb: any) => cb(null, makeSafeFilename(file.originalname)),
  });
}

/** ====== Lógica de validación basada en env ====== */
const BASE_ALLOWED = new Set(env.UPLOAD_ALLOWED_MIME);
/** Para tickets permitimos además PKPASS (si no vino en .env) */
const TICKET_ALLOWED = new Set([
  ...BASE_ALLOWED,
  'application/vnd.apple.pkpass',
]);

/** Límite de tamaño (bytes) desde env.UPLOAD_MAX_MB (default en env.ts = 5MB) */
const BASE_MAX_BYTES = Math.max(1, env.UPLOAD_MAX_MB) * 1024 * 1024;
/**
 * Para tickets, por compatibilidad con PDFs pesados, usamos como mínimo 20 MB.
 * Si quieres un límite distinto, cambia UPLOAD_MAX_MB en .env.
 */
const TICKET_MAX_BYTES = Math.max(BASE_MAX_BYTES, 20 * 1024 * 1024);

/** Fábrica de filtros por MIME */
function makeMimeFilter(allowed: Set<string>, errorMsg: string) {
  return (_req: any, file: any, cb: any) => {
    if (!allowed.has(file.mimetype)) {
      return cb(new Error(errorMsg));
    }
    cb(null, true);
  };
}

const allowDocumentMimes = makeMimeFilter(
  BASE_ALLOWED,
  `Solo se permiten archivos: ${Array.from(BASE_ALLOWED).join(', ')}`
);

const allowTicketMimes = makeMimeFilter(
  TICKET_ALLOWED,
  'Archivo de ticket no permitido. Usa JPG, PNG, WebP, PDF o PKPASS'
);

/** ====== Uploaders ====== */

/** Uploader para DOCUMENTOS (verificación/KYC) */
export const upload = multer({
  storage: makeStorage('documents'),
  limits: { fileSize: BASE_MAX_BYTES },
  fileFilter: allowDocumentMimes,
});

/** Uploader para TICKETS (reventa/escrow) */
export const uploadTickets = multer({
  storage: makeStorage('tickets'),
  limits: { fileSize: TICKET_MAX_BYTES },
  fileFilter: allowTicketMimes,
});

/** Helper opcional por si quieres inspeccionar rutas desde otros módulos */
export function getUploadsPaths() {
  return {
    root: uploadsRoot,
    documents: uploadsDirs.documents,
    tickets: uploadsDirs.tickets,
  };
}




