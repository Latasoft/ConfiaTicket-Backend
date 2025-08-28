// src/routes/auth.routes.ts
import { Router } from 'express';
import { authenticateToken } from '../middleware/authMiddleware';
import {
  register,
  login,
  me,
  changePassword,
  deleteAccount,
  logoutAll,
  changeEmail, // 👈 NUEVO
} from '../controllers/auth.controller';
import { authLimiter } from '../middleware/rateLimit'; // Rate limiter para proteger endpoints públicos

const router = Router();

/**
 * Endpoints públicos protegidos con rate limit
 * - register: crea usuario nuevo (solo buyer/organizer)
 * - login: autentica y devuelve token
 */
router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);

/**
 * Perfil actual del usuario autenticado
 * - Usa authenticateToken para extraer el userId desde el JWT
 */
router.get('/me', authenticateToken, me);

/**
 * Cambio de contraseña desde sesión activa (sin email)
 * - Requiere JWT
 * - body: { currentPassword, newPassword }
 */
router.post('/change-password', authenticateToken, changePassword);

/**
 * Eliminar mi cuenta (borrado suave)
 * - Requiere JWT
 * - body: { password }
 */
router.post('/delete-account', authenticateToken, deleteAccount);

/**
 * Cerrar sesión en todos los dispositivos (invalida tokens previos)
 * - Requiere JWT
 */
router.post('/logout-all', authenticateToken, logoutAll);

/**
 * Cambiar correo (requiere contraseña)
 * - Requiere JWT
 * - body: { password, newEmail }
 */
router.post('/change-email', authenticateToken, changeEmail); // 👈 NUEVO

export default router;








