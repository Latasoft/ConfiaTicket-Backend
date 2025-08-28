// src/utils/auth.ts
import bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import { env } from '../config/env';
import crypto from 'crypto'; // 👈 helpers reset

export const ROLES = ['superadmin', 'organizer', 'buyer'] as const;
export type AppRole = typeof ROLES[number];

export interface TokenPayload {
  userId: number;
  role: AppRole;
  /** 🔐 NUEVO: versión de token para invalidar sesiones (logout-all). */
  tokenVersion?: number;
  iat?: number;
  exp?: number;
}

export function coerceRole(value: unknown): AppRole {
  // Acepta 'user' del frontend como 'buyer'
  if (value === 'user') return 'buyer';
  if (typeof value === 'string' && (ROLES as readonly string[]).includes(value)) {
    return value as AppRole;
  }
  // Valor desconocido → degradar a buyer (o lanza error si prefieres)
  return 'buyer';
}

// Lee SALT_ROUNDS desde env si existe; default 10
const SALT_ROUNDS =
  Number.isFinite(Number(env.BCRYPT_SALT_ROUNDS))
    ? Number(env.BCRYPT_SALT_ROUNDS)
    : 10;

// Normaliza EXPIRES_IN (número si es numérico; si no, string). Default '7d'
const EXPIRES_IN: string | number = (() => {
  const raw = env.JWT_EXPIRES_IN;
  if (raw == null || raw === '') return '7d';
  const n = Number(raw);
  return Number.isFinite(n) ? n : String(raw);
})();

// Valida que exista el secreto
const JWT_SECRET = env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('Falta JWT_SECRET en la configuración de entorno');
}

/** Hashear contraseña */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/** Comparar contraseña */
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Generar JWT */
export function generateToken(payload: TokenPayload): string {
  // Compatibilidad: si no viene tokenVersion desde el controller, asumir 0
  const fullPayload: TokenPayload = {
    ...payload,
    tokenVersion: payload.tokenVersion ?? 0,
  };
  return jwt.sign(fullPayload as any, JWT_SECRET as any, { expiresIn: EXPIRES_IN as any } as any);
}

/** Verificar JWT */
export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET as any) as TokenPayload;
}

/* ====================== Helpers reset de contraseña ====================== */

/**
 * Genera un token de reseteo y su hash.
 * - raw: token plano para enviar por email / URL
 * - hash: versión SHA-256 para guardar en DB
 */
export function createPasswordResetToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

/**
 * Calcula la fecha de expiración del token (por defecto 1 hora hacia adelante).
 */
export function passwordResetExpiry(hours = 1): Date {
  const expires = new Date();
  expires.setHours(expires.getHours() + hours);
  return expires;
}





