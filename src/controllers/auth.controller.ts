// src/controllers/auth.controller.ts
import { Request, Response } from 'express';
import prisma from '../prisma/client';
import { hashPassword, comparePassword, generateToken, coerceRole } from '../utils/auth';

// === Config bloqueo login ===
const MAX_FAILED_LOGINS = 5;   // intentos antes de bloquear
const LOCK_MINUTES = 15;       // minutos bloqueado

// Mantén esta lista si quieres validar payload de registro
const ALLOWED_ROLES = new Set(['superadmin', 'organizer', 'buyer']);

/* ===================== Límites de longitud (DB/seguridad) ===================== */
const LIMITS = {
  NAME: 100,               // user.name  @db.VarChar(100)
  EMAIL: 254,              // user.email @db.VarChar(254)
  ROLE: 16,                // user.role  @db.VarChar(16)
  RUT: 16,                 // user.rut   @db.VarChar(16)
  RAW_PASSWORD_MAX: 128,   // límite defensivo: no guardamos raw, pero evitamos strings ridículas
};

// Utilidades básicas
function toStr(v: unknown) {
  return String(v ?? '').trim();
}
function isValidEmail(s: string) {
  // simple y robusto, suficiente para backend
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/* ============================ Utilidades RUT ============================= */
// Normaliza a "XXXXXXXX-D" (sin puntos; guion antes del DV; DV en mayúscula).
// Si no tiene forma de RUT, devuelve "".
function normalizeRut(input: string): string {
  const raw = String(input || '')
    .replace(/\./g, '')
    .replace(/-/g, '')
    .toUpperCase();

  // 7 u 8 dígitos + DV (0-9 o K)
  const m = raw.match(/^(\d{7,8})([0-9K])$/);
  if (!m) return '';
  const body = m[1]!;
  const dv = m[2]!;
  return `${body}-${dv}`;
}

// Calcula dígito verificador para el cuerpo (sin DV)
function calcRutDv(body: string): string {
  let sum = 0;
  let mul = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += parseInt(body[i]!, 10) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const res = 11 - (sum % 11);
  if (res === 11) return '0';
  if (res === 10) return 'K';
  return String(res);
}

// Valida forma + DV del RUT
function validateRut(input: string): boolean {
  const norm = normalizeRut(input);
  if (!norm) return false;
  const m = norm.match(/^(\d{7,8})-([0-9K])$/);
  if (!m) return false;
  const body = m[1]!;
  const dv = m[2]!;
  const dvCalc = calcRutDv(body);
  return dv === dvCalc;
}

/* ============================================================================
   POLÍTICA DE CONTRASEÑAS (backend)
   - Mínimo 8 caracteres
   - Máximo LIMITS.RAW_PASSWORD_MAX
   - Debe cumplir al menos 3 de 4 categorías: minúscula, mayúscula, dígito, símbolo
   - No debe contener el nombre (tokens) ni la parte local del email (antes de @)
   - Evita contraseñas muy comunes
   Devuelve: null si OK, o string con el motivo si NO cumple
============================================================================ */
function validatePasswordPolicy(
  password: string,
  opts?: { email?: string; name?: string }
): string | null {
  if (typeof password !== 'string') return 'Contraseña inválida.';
  if (password.length < 8) {
    return 'La contraseña debe tener al menos 8 caracteres.';
  }
  if (password.length > LIMITS.RAW_PASSWORD_MAX) {
    return `La contraseña no debe exceder ${LIMITS.RAW_PASSWORD_MAX} caracteres.`;
  }

  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  const categories = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;
  if (categories < 3) {
    return 'La contraseña debe incluir al menos 3 de: minúsculas, mayúsculas, números y símbolos.';
  }

  const commons = new Set([
    'password',
    '12345678',
    '123456789',
    'qwertyui',
    'qwerty123',
    '11111111',
    '00000000',
    'letmein',
    'passw0rd',
  ]);
  if (commons.has(password.toLowerCase())) {
    return 'La contraseña es demasiado común. Elige otra más segura.';
  }

  if (opts?.email) {
    const local = opts.email.split('@')[0]?.toLowerCase();
    if (local && local.length >= 3 && password.toLowerCase().includes(local)) {
      return 'La contraseña no debe contener tu email.';
    }
  }
  if (opts?.name) {
    const tokens = String(opts.name)
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 3);
    for (const t of tokens) {
      if (t && password.toLowerCase().includes(t)) {
        return 'La contraseña no debe contener tu nombre.';
      }
    }
  }

  return null;
}

/**
 * Registro de usuario (con RUT obligatorio)
 */
export async function register(req: Request, res: Response) {
  let { name, email, rut, password, role } = req.body as {
    name?: string;
    email?: string;
    rut?: string;
    password?: string;
    role?: string;
  };

  // Normalizaciones mínimas
  name = toStr(name);
  email = toStr(email).toLowerCase();
  rut = toStr(rut);
  role = toStr(role);

  if (!name || !email || !rut || !password || !role) {
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  }

  // Límites de longitud
  if (name.length > LIMITS.NAME) {
    return res.status(400).json({ error: `El nombre excede ${LIMITS.NAME} caracteres` });
  }
  if (email.length > LIMITS.EMAIL) {
    return res.status(400).json({ error: `El email excede ${LIMITS.EMAIL} caracteres` });
  }
  if (role.length > LIMITS.ROLE) {
    return res.status(400).json({ error: `El rol excede ${LIMITS.ROLE} caracteres` });
  }
  if (rut.length > LIMITS.RUT) {
    return res.status(400).json({ error: `El RUT excede ${LIMITS.RUT} caracteres` });
  }

  // Email válido
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Email inválido' });
  }

  if (!ALLOWED_ROLES.has(role)) {
    return res.status(400).json({ error: 'Rol inválido' });
  }

  // Seguridad: no permitir crear superadmin vía registro público
  if (role === 'superadmin') {
    return res.status(403).json({ error: 'No autorizado para rol superadmin' });
  }

  // ✅ RUT
  const normRut = normalizeRut(rut);
  if (!validateRut(normRut)) {
    return res.status(400).json({ error: 'RUT inválido' });
  }
  if (normRut.length > LIMITS.RUT) {
    return res.status(400).json({ error: `El RUT excede ${LIMITS.RUT} caracteres` });
  }

  // ✅ Política de contraseña
  {
    const policyError = validatePasswordPolicy(password, { email, name });
    if (policyError) {
      return res.status(400).json({ error: policyError });
    }
  }

  try {
    const [existingEmail, existingRut] = await Promise.all([
      prisma.user.findUnique({ where: { email } }),
      prisma.user.findUnique({ where: { rut: normRut } }),
    ]);

    if (existingEmail) {
      return res.status(409).json({ error: 'Email ya registrado' });
    }
    if (existingRut) {
      return res.status(409).json({ error: 'RUT ya registrado' });
    }

    const hashed = await hashPassword(password);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        rut: normRut,              // 👈 guardamos RUT normalizado
        password: hashed,
        role,                      // 'buyer' u 'organizer' (superadmin bloqueado arriba)
      },
      select: {
        id: true,
        name: true,
        email: true,
        rut: true,
        role: true,
        isVerified: true,
        canSell: true,
        tokenVersion: true,        // 👈
      },
    });

    // Generar token — incluye tokenVersion (0 en nuevo usuario)
    const token = generateToken({
      userId: user.id,
      role: coerceRole(user.role),
      tokenVersion: user.tokenVersion ?? 0,
    });

    return res.status(201).json({
      message: 'Usuario creado',
      token,
      user,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Error en servidor' });
  }
}

/**
 * Login (acepta RUT o email + contraseña) con bloqueo por intentos fallidos
 */
export async function login(req: Request, res: Response) {
  // Aceptamos rutOrEmail (nuevo), o los campos antiguos email / rut
  const { rutOrEmail, email, rut, password } = req.body as {
    rutOrEmail?: string;
    email?: string;
    rut?: string;
    password?: string;
  };

  const identifierRaw = toStr(rutOrEmail ?? email ?? rut ?? '');
  const passwordRaw = String(password ?? '');

  if (!identifierRaw || !passwordRaw) {
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  }

  // Límites defensivos
  if (identifierRaw.length > LIMITS.EMAIL) {
    return res.status(400).json({ error: 'Identificador demasiado largo' });
  }
  if (passwordRaw.length > LIMITS.RAW_PASSWORD_MAX) {
    return res.status(400).json({ error: `La contraseña no debe exceder ${LIMITS.RAW_PASSWORD_MAX} caracteres` });
  }

  try {
    const now = new Date();

    // ¿Es un RUT válido? (si sí, buscamos por rut normalizado; si no, por email)
    const isRut = validateRut(identifierRaw);
    const identifier = isRut
      ? normalizeRut(identifierRaw)
      : identifierRaw.toLowerCase();

    // Búsqueda del usuario
    const user = await prisma.user.findUnique({
      where: isRut ? { rut: identifier } : { email: identifier },
      select: {
        id: true,
        name: true,
        email: true,
        password: true, // para comparar
        role: true,
        isVerified: true,
        canSell: true,
        isActive: true,     // bloquear login si está desactivado
        tokenVersion: true, // 👈
        failedLoginCount: true, // 👈 bloqueo
        lockUntil: true,        // 👈 bloqueo
      },
    });

    // Mensaje genérico si no existe (para no filtrar identificadores válidos)
    if (!user) {
      return res.status(401).json({ error: 'RUT/email o contraseña incorrectos' });
    }

    if (user.isActive === false) {
      return res.status(403).json({ error: 'Cuenta desactivada' });
    }

    // Si el bloqueo expiró, limpiamos antes de continuar
    if (user.lockUntil && user.lockUntil <= now) {
      await prisma.user.update({
        where: { id: user.id },
        data: { lockUntil: null, failedLoginCount: 0 },
      });
      user.lockUntil = null;
      user.failedLoginCount = 0;
    }

    // Si sigue bloqueado, avisamos tiempo restante (423 + lockUntil en ms)
    if (user.lockUntil && user.lockUntil > now) {
      const msLeft = user.lockUntil.getTime() - now.getTime();
      const mins = Math.max(1, Math.ceil(msLeft / 60000));
      return res.status(423).json({
        error: `Cuenta temporalmente bloqueada. Intenta en ${mins} min.`,
        lockUntil: user.lockUntil.getTime(),
      });
    }

    // Validar contraseña
    const valid = await comparePassword(passwordRaw, user.password);
    if (!valid) {
      const newCount = (user.failedLoginCount ?? 0) + 1;
      const attemptsRemaining = Math.max(0, MAX_FAILED_LOGINS - newCount);

      if (newCount >= MAX_FAILED_LOGINS) {
        const until = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
        await prisma.user.update({
          where: { id: user.id },
          data: { failedLoginCount: 0, lockUntil: until },
        });
        return res.status(423).json({
          error: `Cuenta bloqueada por ${LOCK_MINUTES} min.`,
          lockUntil: until.getTime(),
        });
      } else {
        await prisma.user.update({
          where: { id: user.id },
          data: { failedLoginCount: newCount },
        });
        return res.status(401).json({
          error: 'RUT/email o contraseña incorrectos',
          attemptsRemaining, // 👈 cuántos intentos quedan antes del bloqueo
        });
      }
    }

    // Login OK → resetear contadores/bloqueo si hubiera algo
    if (user.failedLoginCount > 0 || user.lockUntil) {
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockUntil: null },
      });
    }

    const token = generateToken({
      userId: user.id,
      role: coerceRole(user.role),
      tokenVersion: user.tokenVersion, // 👈 importante para logout-all
    });

    // No devolvemos password al cliente
    const { password: _omit, ...safeUser } = user;

    return res.json({
      token,
      user: safeUser,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Error en servidor' });
  }
}

/**
 * Perfil actual (requiere JWT)
 * Devuelve el perfil mínimo que el front necesita para hidratar la sesión.
 * - verifiedOrganizer = organizer && isVerified && canSell
 */
export async function me(req: Request, res: Response) {
  try {
    const authUser = (req as any).user as { id?: number; userId?: number } | undefined;
    const userId = authUser?.id ?? authUser?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        role: true,
        isVerified: true,
        canSell: true,
        rut: true, // 👈 enviamos el RUT al front
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const verifiedOrganizer =
      user.role === 'organizer' && user.isVerified === true && user.canSell === true;

    return res.json({
      id: user.id,
      name: user.name,
      role: user.role,
      rut: user.rut ?? null,
      verifiedOrganizer,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Error al obtener el perfil' });
  }
}

/* ============================================================================ */
/* ====================== Cambio de contraseña (con sesión) =================== */
/* ============================================================================ */

/**
 * POST /auth/change-password
 * Requiere JWT.
 * body: { currentPassword: string, newPassword: string }
 */
export async function changePassword(req: Request, res: Response) {
  try {
    const authUser = (req as any).user as { id?: number; userId?: number } | undefined;
    const userId = authUser?.id ?? authUser?.userId;
    if (!userId) return res.status(401).json({ error: 'No autenticado' });

    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }
    if (currentPassword.length > LIMITS.RAW_PASSWORD_MAX || newPassword.length > LIMITS.RAW_PASSWORD_MAX) {
      return res.status(400).json({ error: `Las contraseñas no deben exceder ${LIMITS.RAW_PASSWORD_MAX} caracteres` });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true, isActive: true, email: true, name: true },
    });

    if (!user || user.isActive === false) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const ok = await comparePassword(currentPassword, user.password);
    if (!ok) {
      return res.status(400).json({ error: 'Contraseña actual incorrecta' });
    }

    // ✅ Política de contraseña al cambiar
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: 'La nueva contraseña no puede ser igual a la actual.' });
    }
    {
      const policyError = validatePasswordPolicy(newPassword, {
        email: user.email,
        name: user.name,
      });
      if (policyError) {
        return res.status(400).json({ error: policyError });
      }
    }

    const newHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: { password: newHash },
    });

    return res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (e) {
    console.error('changePassword error:', e);
    return res.status(500).json({ error: 'No se pudo cambiar la contraseña' });
  }
}

/* ============================================================================ */
/* =========================== Eliminar mi cuenta ============================= */
/* ============================================================================ */

/**
 * POST /auth/delete-account
 * Requiere JWT.
 * body: { password: string }
 * Marca la cuenta como desactivada (soft-delete) y registra deletedAt.
 */
export async function deleteAccount(req: Request, res: Response) {
  try {
    const authUser = (req as any).user as { id?: number; userId?: number } | undefined;
    const userId = authUser?.id ?? authUser?.userId;
    if (!userId) return res.status(401).json({ error: 'No autenticado' });

    const { password } = req.body as { password?: string };
    if (!password) return res.status(400).json({ error: 'Contraseña requerida' });
    if (password.length > LIMITS.RAW_PASSWORD_MAX) {
      return res.status(400).json({ error: `La contraseña no debe exceder ${LIMITS.RAW_PASSWORD_MAX} caracteres` });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true, isActive: true },
    });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (user.isActive === false) {
      return res.status(400).json({ error: 'La cuenta ya está desactivada' });
    }

    const ok = await comparePassword(password, user.password);
    if (!ok) return res.status(400).json({ error: 'Contraseña incorrecta' });

    await prisma.user.update({
      where: { id: user.id },
      data: {
        isActive: false,
        deletedAt: new Date(),
      },
    });

    // El frontend debería cerrar sesión tras recibir 200
    return res.json({ message: 'Cuenta desactivada correctamente' });
  } catch (e) {
    console.error('deleteAccount error:', e);
    return res.status(500).json({ error: 'No se pudo desactivar la cuenta' });
  }
}

/* ============================================================================ */
/* =============== Cerrar sesión en todos los dispositivos ==================== */
/* ============================================================================ */

/**
 * POST /auth/logout-all
 * Requiere JWT.
 * Sube tokenVersion para invalidar todos los tokens emitidos previamente.
 */
export async function logoutAll(req: Request, res: Response) {
  try {
    const authUser = (req as any).user as { id?: number; userId?: number } | undefined;
    const userId = authUser?.id ?? authUser?.userId;
    if (!userId) return res.status(401).json({ error: 'No autenticado' });

    await prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });

    return res.json({ message: 'Sesiones cerradas en todos los dispositivos' });
  } catch (e) {
    console.error('logoutAll error:', e);
    return res.status(500).json({ error: 'No se pudo cerrar la sesión en todos los dispositivos' });
  }
}

/* ============================================================================ */
/* ============================ Cambiar correo ================================ */
/* ============================================================================ */

/**
 * POST /auth/change-email
 * Requiere JWT.
 * body: { password: string, newEmail: string }
 * - Verifica contraseña
 * - Normaliza y valida el nuevo email
 * - Rechaza si es igual al actual o si ya está en uso
 */
export async function changeEmail(req: Request, res: Response) {
  try {
    const authUser = (req as any).user as { id?: number; userId?: number } | undefined;
    const userId = authUser?.id ?? authUser?.userId;
    if (!userId) return res.status(401).json({ error: 'No autenticado' });

    const { password, newEmail } = req.body as { password?: string; newEmail?: string };
    if (!password || !newEmail) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }
    if (password.length > LIMITS.RAW_PASSWORD_MAX) {
      return res.status(400).json({ error: `La contraseña no debe exceder ${LIMITS.RAW_PASSWORD_MAX} caracteres` });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, password: true, isActive: true },
    });
    if (!user || !user.isActive) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const ok = await comparePassword(password, user.password);
    if (!ok) {
      return res.status(400).json({ error: 'Contraseña incorrecta' });
    }

    // Normaliza email
    const normalized = toStr(newEmail).toLowerCase();

    // Validación de formato y longitud
    if (!isValidEmail(normalized)) {
      return res.status(400).json({ error: 'Formato de email inválido' });
    }
    if (normalized.length > LIMITS.EMAIL) {
      return res.status(400).json({ error: `El email excede ${LIMITS.EMAIL} caracteres` });
    }

    if (normalized === user.email) {
      return res.status(400).json({ error: 'El nuevo correo es igual al actual' });
    }

    const exists = await prisma.user.findUnique({ where: { email: normalized } });
    if (exists) {
      return res.status(409).json({ error: 'Email ya en uso' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { email: normalized },
    });

    return res.json({ message: 'Correo actualizado correctamente', email: normalized });
  } catch (e) {
    console.error('changeEmail error:', e);
    return res.status(500).json({ error: 'No se pudo actualizar el correo' });
  }
}



