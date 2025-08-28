import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import prisma from '../prisma/client';

export interface JwtPayload {
  userId: number;
  role: 'superadmin' | 'organizer' | 'buyer';
  tokenVersion?: number;
  iat?: number;
  exp?: number;
}

export interface AuthUser {
  id: number;
  role: 'superadmin' | 'organizer' | 'buyer';
}

/**
 * Helper: obtener el usuario autenticado adjuntado en req.user
 */
export function getAuthUser(req: Request): AuthUser | undefined {
  return req.user as AuthUser | undefined;
}

/**
 * Autenticación por JWT (Bearer)
 * - Valida el token.
 * - Compara tokenVersion con DB (invalida tokens viejos tras logout-all).
 * - Adjunta { id, role } en req.user.
 * - IMPORTANTE: devuelve 401 en cualquier problema de autenticación.
 */
export async function authenticateToken(req: Request, res: Response, next: NextFunction) {
  // Permitir preflight CORS sin token
  if (req.method === 'OPTIONS') return next();

  const authHeader = req.headers['authorization']; // 'Bearer <token>'
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;

    // Validar tokenVersion contra DB (logout-all)
    const dbUser = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { tokenVersion: true },
    });
    if (!dbUser) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    const tokenVer = payload.tokenVersion ?? 0;
    if (tokenVer !== dbUser.tokenVersion) {
      return res.status(401).json({ error: 'Sesión inválida. Vuelve a iniciar sesión.' });
    }

    req.user = { id: payload.userId, role: payload.role } as AuthUser;
    next();
  } catch {
    // Antes devolvía 403; ahora 401 para que el front fuerce re-login
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

/**
 * Rechaza si la cuenta está desactivada o eliminada (soft-delete).
 * Úsalo después de authenticateToken:
 *   router.use(authenticateToken, ensureActiveAccount, ...rutas)
 */
export async function ensureActiveAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'No autenticado' });

    const db = await prisma.user.findUnique({
      where: { id: user.id },
      select: { isActive: true, deletedAt: true },
    });

    if (!db) return res.status(401).json({ error: 'No autenticado' });

    if (!db.isActive || db.deletedAt) {
      return res.status(401).json({ error: 'Cuenta desactivada o eliminada' });
    }

    return next();
  } catch (err) {
    console.error('Error en ensureActiveAccount:', err);
    return res.status(500).json({ error: 'Error validando estado de cuenta' });
  }
}

/**
 * Autorización por rol (uno o varios)
 */
export function authorizeRoles(...roles: AuthUser['role'][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'No autenticado' });
    if (!roles.includes(user.role)) {
      return res.status(403).json({ error: 'Acceso no autorizado' });
    }
    next();
  };
}

/**
 * Atajo: requiere superadmin
 */
export function requireSuperadmin(req: Request, res: Response, next: NextFunction) {
  const user = getAuthUser(req);
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  if (user.role !== 'superadmin') return res.status(403).json({ error: 'Acceso no autorizado' });
  next();
}

/**
 * Requiere que el usuario sea ORGANIZER verificado y con permiso de venta activo.
 * - Si es SUPERADMIN: pasa directo.
 * - Si es ORGANIZER: debe tener cuenta activa (isActive && !deletedAt),
 *   y además isVerified === true y canSell === true.
 * - Otros roles: 403.
 */
export async function requireVerifiedOrganizer(req: Request, res: Response, next: NextFunction) {
  try {
    const user = getAuthUser(req);
    if (!user) return res.status(401).json({ error: 'No autenticado' });

    // Superadmin bypass
    if (user.role === 'superadmin') return next();

    if (user.role !== 'organizer') {
      return res.status(403).json({ error: 'Solo organizadores pueden realizar esta acción' });
    }

    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { isActive: true, deletedAt: true, isVerified: true, canSell: true },
    });

    if (!dbUser) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (!dbUser.isActive || dbUser.deletedAt) {
      return res.status(401).json({ error: 'Cuenta desactivada o eliminada' });
    }

    if (!dbUser.isVerified) {
      return res.status(403).json({ error: 'Su cuenta está pendiente de verificación' });
    }
    if (!dbUser.canSell) {
      return res.status(403).json({ error: 'Permiso de venta deshabilitado. Contacte al administrador.' });
    }

    return next();
  } catch (err) {
    console.error('Error en requireVerifiedOrganizer:', err);
    return res.status(500).json({ error: 'Error validando permisos de organizador' });
  }
}






