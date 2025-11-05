// src/config/env.ts
import dotenv from "dotenv";
dotenv.config();

/* ================= Helpers ================= */
function toInt(v: string | undefined, def: number) {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : def;
}
function toBool(v: string | undefined, def: boolean) {
  if (v == null) return def;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return def;
}
function toList(v: string | undefined, def: string[]) {
  return v ? v.split(",").map(s => s.trim()).filter(Boolean) : def;
}
function nonEmpty(v: string | undefined | null) {
  return !!v && String(v).trim().length > 0;
}
function requireWhen(cond: boolean, name: string, value?: string) {
  if (cond && (!value || !String(value).trim())) {
    throw new Error(`Falta variable requerida: ${name}`);
  }
}

/* ================= Carga base ================= */
const NODE_ENV = process.env.NODE_ENV ?? "development";
const IS_PROD = NODE_ENV === "production";

const BACKEND_URL = process.env.BACKEND_URL ?? "";
const FRONTEND_URL_RAW = process.env.FRONTEND_URL ?? "";
const CORS_ORIGINS = toList(FRONTEND_URL_RAW, []).length
  ? toList(FRONTEND_URL_RAW, [])
  : (nonEmpty(FRONTEND_URL_RAW) ? [FRONTEND_URL_RAW] : []);

const WEBPAY_RETURN_URL_DEFAULT = nonEmpty(BACKEND_URL)
  ? `${BACKEND_URL}/api/payments/return`
  : undefined;
const WEBPAY_RETURN_URL_RESALE_DEFAULT = nonEmpty(BACKEND_URL)
  ? `${BACKEND_URL}/api/payments/resale/return`
  : undefined;
// Página de resultado en el FRONT
const WEBPAY_FINAL_URL_DEFAULT = CORS_ORIGINS[0]
  ? `${CORS_ORIGINS[0]}/payment-result`
  : undefined;

/* ================= Export ================= */
export const env = {
  /* ===== Core ===== */
  NODE_ENV,
  IS_PROD,
  PORT: toInt(process.env.PORT, 4000),
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  JWT_SECRET: process.env.JWT_SECRET ?? "changeme",
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN, // ej: "7d"
  BCRYPT_SALT_ROUNDS: toInt(process.env.BCRYPT_SALT_ROUNDS, 10),

  /* ===== Email ===== */
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: toInt(process.env.SMTP_PORT, 587),
  SMTP_SECURE: toBool(process.env.SMTP_SECURE, false),
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  MAIL_FROM: process.env.MAIL_FROM,
  ADMIN_NOTIFICATION_EMAIL: process.env.ADMIN_NOTIFICATION_EMAIL,

  /* ===== URLs App ===== */
  FRONTEND_URL: FRONTEND_URL_RAW,
  BACKEND_URL,

  /* Lista para CORS (coma-separado en FRONTEND_URL) */
  CORS_ORIGINS,

  /* ===== Subidas de archivos ===== */
  UPLOAD_DIR: process.env.UPLOAD_DIR, // si usas disco persistente
  UPLOAD_MAX_MB: toInt(process.env.UPLOAD_MAX_MB, 5),
  UPLOAD_ALLOWED_MIME: toList(
    process.env.UPLOAD_ALLOWED_MIME,
    ["image/jpeg", "image/png", "image/webp", "application/pdf"]
  ),
  STORAGE_DRIVER: (process.env.STORAGE_DRIVER ?? "local").toLowerCase(), // 'local' | 's3'
  S3_BUCKET: process.env.S3_BUCKET,
  S3_REGION: process.env.S3_REGION,
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
  S3_PREFIX: process.env.S3_PREFIX ?? "uploads/",

  /* ===== Webpay / Transbank (pay-in clásico) ===== */
  WEBPAY_ENV: process.env.WEBPAY_ENV ?? "INTEGRATION", // INTEGRATION | PRODUCTION
  WEBPAY_COMMERCE_CODE: process.env.WEBPAY_COMMERCE_CODE ?? "",
  WEBPAY_API_KEY: process.env.WEBPAY_API_KEY ?? "",
  WEBPAY_RETURN_URL: process.env.WEBPAY_RETURN_URL ?? WEBPAY_RETURN_URL_DEFAULT,
  WEBPAY_RETURN_URL_RESALE:
    process.env.WEBPAY_RETURN_URL_RESALE ?? WEBPAY_RETURN_URL_RESALE_DEFAULT,
  WEBPAY_FINAL_URL: process.env.WEBPAY_FINAL_URL ?? WEBPAY_FINAL_URL_DEFAULT,

  /* ===== Tickets (compras directas) ===== */
  TICKET_UPLOAD_DEADLINE_HOURS: toInt(process.env.TICKET_UPLOAD_DEADLINE_HOURS, 24),

  /* ⏱️ Retención de la pre-autorización (horas) */
  AUTH_HOLD_HOURS: toInt(process.env.AUTH_HOLD_HOURS, 72),

  /* ⏱️ Tiempo de hold de reservas (minutos) */
  RESERVATION_HOLD_MINUTES: toInt(process.env.RESERVATION_HOLD_MINUTES, 15),

  /* ===== Límites de negocio ===== */
  MAX_TICKETS_PER_PURCHASE: toInt(process.env.MAX_TICKETS_PER_PURCHASE, 4),
  CLAIM_DEADLINE_HOURS: toInt(process.env.CLAIM_DEADLINE_HOURS, 48),

  /* ===== Reventa / Escrow ===== */
  RESALE_ESCROW_UPLOAD_HOURS: toInt(process.env.RESALE_ESCROW_UPLOAD_HOURS, 24),
  RESALE_ESCROW_CONFIRM_HOURS: toInt(process.env.RESALE_ESCROW_CONFIRM_HOURS, 24),
  RESALE_ESCROW_DISPUTE_HOURS: toInt(process.env.RESALE_ESCROW_DISPUTE_HOURS, 48),

  /* ===== Antifraude ===== */
  ANTIFRAUD_ENABLE_OCR: toBool(process.env.ANTIFRAUD_ENABLE_OCR, false),
  ANTIFRAUD_ENABLE_PDF_VALIDATION: toBool(process.env.ANTIFRAUD_ENABLE_PDF_VALIDATION, false),

  /* ===== Payouts / Conector genérico ===== */
  // 'sim' (simulado) permitido en prod si NO usas split
  // Si usas split/marketplace, debe ser 'http'
  PAYOUTS_DRIVER: (process.env.PAYOUTS_DRIVER ?? "sim").toLowerCase() as "sim" | "http",
  PAYOUTS_HTTP_BASEURL: process.env.PAYOUTS_HTTP_BASEURL,
  PAYOUTS_HTTP_APIKEY: process.env.PAYOUTS_HTTP_APIKEY,

  /* ===== Jobs de reconciliación ===== */
  PAYOUTS_RECONCILE_JOB_ENABLED: toBool(process.env.PAYOUTS_RECONCILE_JOB_ENABLED, true),
  PAYOUTS_RECONCILE_INTERVAL_MINUTES: toInt(process.env.PAYOUTS_RECONCILE_INTERVAL_MINUTES, 30),
  PAYOUTS_RECONCILE_LIMIT: toInt(process.env.PAYOUTS_RECONCILE_LIMIT, 200),

  /* ===== Jobs de reintentos ===== */
  PAYOUTS_RETRY_JOB_ENABLED: toBool(process.env.PAYOUTS_RETRY_JOB_ENABLED, true),
  PAYOUTS_RETRY_INTERVAL_MINUTES: toInt(process.env.PAYOUTS_RETRY_INTERVAL_MINUTES, 5),
  PAYOUTS_RETRY_LIMIT: toInt(process.env.PAYOUTS_RETRY_LIMIT, 50),
  PAYOUTS_MAX_RETRIES: toInt(process.env.PAYOUTS_MAX_RETRIES, 5),
  // CSV de segundos: "60,300,1800,10800,86400"
  PAYOUTS_RETRY_SCHEDULE: process.env.PAYOUTS_RETRY_SCHEDULE,

  /* =================================================================
     ============ PSP Marketplace (Split / Escrow) – Opción B =========
     ================================================================= */
  PSP_PROVIDER: (process.env.PSP_PROVIDER ?? "none").toUpperCase(), // 'NONE' | 'KUSHKI' | 'MP'
  PSP_ENV: (process.env.PSP_ENV ?? "SANDBOX").toUpperCase(),
  PSP_ENABLE_SPLIT: toBool(process.env.PSP_ENABLE_SPLIT, false), // <- por defecto OFF
  PSP_CAPTURE_POLICY: process.env.PSP_CAPTURE_POLICY ?? "MANUAL_ON_APPROVAL",
  PSP_APP_FEE_BPS: toInt(process.env.PSP_APP_FEE_BPS, 0),
  PSP_WEBHOOK_TOLERANCE_SECONDS: toInt(process.env.PSP_WEBHOOK_TOLERANCE_SECONDS, 300),

  PSP_CONNECT_SUCCESS_URL:
    process.env.PSP_CONNECT_SUCCESS_URL ??
    (CORS_ORIGINS[0] ? `${CORS_ORIGINS[0]}/organizer/payout-settings?status=success` : undefined),
  PSP_CONNECT_FAILURE_URL:
    process.env.PSP_CONNECT_FAILURE_URL ??
    (CORS_ORIGINS[0] ? `${CORS_ORIGINS[0]}/organizer/payout-settings?status=error` : undefined),

  /* ------- Mercado Pago (MP) ------- */
  MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN,
  MP_PUBLIC_KEY: process.env.MP_PUBLIC_KEY,
  MP_WEBHOOK_SECRET: process.env.MP_WEBHOOK_SECRET,
  MP_APP_ID: process.env.MP_APP_ID,
  MP_CLIENT_SECRET: process.env.MP_CLIENT_SECRET,
  MP_REDIRECT_URI: process.env.MP_REDIRECT_URI,
  MP_AUTO_CAPTURE: toBool(process.env.MP_AUTO_CAPTURE, false),

  /* ------- Kushki ------- */
  KUSHKI_PUBLIC_MERCHANT_ID: process.env.KUSHKI_PUBLIC_MERCHANT_ID,
  KUSHKI_PRIVATE_MERCHANT_ID: process.env.KUSHKI_PRIVATE_MERCHANT_ID,
  KUSHKI_ENV: (process.env.KUSHKI_ENV ?? "TEST").toUpperCase(),
  KUSHKI_WEBHOOK_SECRET: process.env.KUSHKI_WEBHOOK_SECRET,
} as const;

/* ================= Validaciones de Producción ================= */
if (env.IS_PROD) {
  // Básicos
  requireWhen(true, "DATABASE_URL", env.DATABASE_URL);
  requireWhen(true, "BACKEND_URL", env.BACKEND_URL);
  requireWhen(true, "JWT_SECRET", env.JWT_SECRET);
  if ((env.JWT_SECRET ?? "").length < 32) {
    throw new Error("JWT_SECRET demasiado corto (usa 32+ caracteres aleatorios).");
  }

  // Webpay siempre requerido en prod (Opción A o B igual cobran con Webpay)
  requireWhen(true, "WEBPAY_ENV", env.WEBPAY_ENV);
  // Permitir INTEGRATION en producción para testing
  // if (env.WEBPAY_ENV !== "PRODUCTION") {
  //   throw new Error("En producción WEBPAY_ENV debe ser PRODUCTION.");
  // }
  requireWhen(true, "WEBPAY_COMMERCE_CODE", env.WEBPAY_COMMERCE_CODE);
  requireWhen(true, "WEBPAY_API_KEY", env.WEBPAY_API_KEY);
  requireWhen(true, "WEBPAY_RETURN_URL", env.WEBPAY_RETURN_URL);
  requireWhen(true, "WEBPAY_FINAL_URL", env.WEBPAY_FINAL_URL);

  // Storage S3 requerido sólo si se usa 's3'
  if (env.STORAGE_DRIVER === "s3") {
    requireWhen(true, "S3_BUCKET", env.S3_BUCKET);
    requireWhen(true, "S3_REGION", env.S3_REGION);
    requireWhen(true, "S3_ACCESS_KEY_ID", env.S3_ACCESS_KEY_ID);
    requireWhen(true, "S3_SECRET_ACCESS_KEY", env.S3_SECRET_ACCESS_KEY);
  }

  // Marketplace / split sólo si está habilitado
  if (env.PSP_ENABLE_SPLIT) {
    // En split, no se permite el driver simulado para payouts
    if (env.PAYOUTS_DRIVER !== "http") {
      throw new Error("Con PSP_ENABLE_SPLIT=true, debes usar PAYOUTS_DRIVER=http.");
    }
    requireWhen(true, "PAYOUTS_HTTP_BASEURL", env.PAYOUTS_HTTP_BASEURL);
    requireWhen(true, "PAYOUTS_HTTP_APIKEY", env.PAYOUTS_HTTP_APIKEY);

    // Proveedor específico
    const provider = env.PSP_PROVIDER;
    if (provider === "KUSHKI") {
      if (env.KUSHKI_ENV !== "PROD") {
        throw new Error("Con KUSHKI en prod, KUSHKI_ENV debe ser PROD.");
      }
      requireWhen(true, "KUSHKI_PRIVATE_MERCHANT_ID", env.KUSHKI_PRIVATE_MERCHANT_ID);
      requireWhen(true, "KUSHKI_PUBLIC_MERCHANT_ID", env.KUSHKI_PUBLIC_MERCHANT_ID);
      requireWhen(true, "KUSHKI_WEBHOOK_SECRET", env.KUSHKI_WEBHOOK_SECRET);
    } else if (provider === "MP") {
      requireWhen(true, "MP_ACCESS_TOKEN", env.MP_ACCESS_TOKEN);
      requireWhen(true, "MP_WEBHOOK_SECRET", env.MP_WEBHOOK_SECRET);
      // opcionales pero recomendados:
      requireWhen(true, "MP_PUBLIC_KEY", env.MP_PUBLIC_KEY);
    } else if (provider === "NONE") {
      throw new Error("PSP_ENABLE_SPLIT=true pero PSP_PROVIDER=NONE. Configura KUSHKI o MP.");
    }
  }
}

/* ================= Tip de uso =================
   - FRONTEND_URL admite varios orígenes separados por coma para CORS.
   - Si no defines WEBPAY_* URLs, se completan con BACKEND_URL/FRONTEND_URL.
   - Puedes dejar PAYOUTS_DRIVER=sim en prod siempre que PSP_ENABLE_SPLIT=false.
*/








