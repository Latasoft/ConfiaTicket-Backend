// src/config/env.ts
import dotenv from 'dotenv';
dotenv.config();

/* Helpers para parsear variables de entorno */
function toInt(v: string | undefined, def: number) {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : def;
}
function toBool(v: string | undefined, def: boolean) {
  if (v == null) return def;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return def;
}
function toList(v: string | undefined, def: string[]) {
  return v ? v.split(',').map(s => s.trim()).filter(Boolean) : def;
}

export const env = {
  /* ===== Core ===== */
  PORT: process.env.PORT ?? '4000',
  DATABASE_URL: process.env.DATABASE_URL ?? '',
  JWT_SECRET: process.env.JWT_SECRET ?? 'changeme',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN, // ej: "7d"
  BCRYPT_SALT_ROUNDS: process.env.BCRYPT_SALT_ROUNDS, // ej: "10"

  /* ===== Email ===== */
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_SECURE: process.env.SMTP_SECURE,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  MAIL_FROM: process.env.MAIL_FROM,

  /* ===== Frontend público ===== */
  // Puede ser una lista separada por comas para CORS (ej: "http://localhost:5173,https://miapp.com")
  FRONTEND_URL: process.env.FRONTEND_URL,

  /* ===== Subidas de archivos (local o S3) ===== */
  // Directorio raíz para archivos subidos cuando se usa almacenamiento local.
  // Si no se define, el server montará "<project>/uploads" por defecto.
  UPLOAD_DIR: process.env.UPLOAD_DIR,

  // Límite de tamaño por archivo (MB) para assets de reventa / documentos
  UPLOAD_MAX_MB: toInt(process.env.UPLOAD_MAX_MB, 5),

  // Tipos MIME permitidos (puedes ampliarlo en .env)
  UPLOAD_ALLOWED_MIME: toList(
    process.env.UPLOAD_ALLOWED_MIME,
    ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
  ),

  // (Opcional) Config S3 si decides guardar archivos en S3 en lugar de disco local
  STORAGE_DRIVER: process.env.STORAGE_DRIVER ?? 'local', // 'local' | 's3'
  S3_BUCKET: process.env.S3_BUCKET,
  S3_REGION: process.env.S3_REGION,
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
  S3_PREFIX: process.env.S3_PREFIX ?? 'uploads/',

  /* ===== Webpay / Transbank ===== */
  WEBPAY_ENV: process.env.WEBPAY_ENV ?? 'INTEGRATION', // INTEGRATION | PRODUCTION
  WEBPAY_COMMERCE_CODE: process.env.WEBPAY_COMMERCE_CODE ?? '',
  WEBPAY_API_KEY: process.env.WEBPAY_API_KEY ?? '',

  // return_url: endpoint público del BACKEND al que Webpay redirige con token_ws para commit
  WEBPAY_RETURN_URL: process.env.WEBPAY_RETURN_URL,
  // return_url específico para flujos de reventa/escrow
  WEBPAY_RETURN_URL_RESALE: process.env.WEBPAY_RETURN_URL_RESALE,

  // final_url: página del FRONTEND donde muestras el resultado (success/failed/aborted)
  WEBPAY_FINAL_URL: process.env.WEBPAY_FINAL_URL,

  /* ===== Tickets (compras directas) ===== */
  // Horas que tiene el comprador/organizador para subir la entrada tras el pago
  TICKET_UPLOAD_DEADLINE_HOURS: toInt(process.env.TICKET_UPLOAD_DEADLINE_HOURS, 24),

  /* ===== Reventa / Escrow (ventanas de tiempo) ===== */
  // Horas que tiene el vendedor para subir la entrada después del pago del comprador
  RESALE_ESCROW_UPLOAD_HOURS: toInt(process.env.RESALE_ESCROW_UPLOAD_HOURS, 24),
  // Horas que tiene el comprador para confirmar recepción/validez después de la entrega
  RESALE_ESCROW_CONFIRM_HOURS: toInt(process.env.RESALE_ESCROW_CONFIRM_HOURS, 24),
  // (Opcional) Horas para ventana de disputa/manual review
  RESALE_ESCROW_DISPUTE_HOURS: toInt(process.env.RESALE_ESCROW_DISPUTE_HOURS, 48),

  /* ===== Antifraude (opcionales) ===== */
  ANTIFRAUD_ENABLE_OCR: toBool(process.env.ANTIFRAUD_ENABLE_OCR, false),
  ANTIFRAUD_ENABLE_PDF_VALIDATION: toBool(process.env.ANTIFRAUD_ENABLE_PDF_VALIDATION, false),
};





