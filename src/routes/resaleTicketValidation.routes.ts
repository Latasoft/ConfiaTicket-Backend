// src/routes/resaleTicketValidation.routes.ts
import { Router } from 'express';
import { authenticateToken, requireVerifiedOrganizer } from '../middleware/authMiddleware';
import { resaleValidationRateLimiter, statsRateLimiter } from '../middleware/rateLimitMiddleware';
import {
  validateResaleTicket,
  getTicketScanStats,
  getEventScanStats,
} from '../controllers/resaleTicketValidation.controller';

const router = Router();

/**
 * Ruta pública para validar tickets de reventa
 * Esta ruta NO requiere autenticación ya que es escaneada por cualquier persona
 * en el acceso al evento (personal de seguridad externo)
 * 
 * Rate limit: 10 validaciones por minuto por IP
 */
router.get('/validate/:proxyQrCode', resaleValidationRateLimiter, validateResaleTicket);

/**
 * Rutas protegidas para organizadores
 * Ver estadísticas y logs de escaneos
 */

// Estadísticas de un ticket específico
router.get(
  '/:proxyQrCode/stats',
  authenticateToken,
  requireVerifiedOrganizer,
  statsRateLimiter,
  getTicketScanStats
);

// Estadísticas de todos los tickets de un evento
router.get(
  '/event/:eventId/scan-stats',
  authenticateToken,
  requireVerifiedOrganizer,
  statsRateLimiter,
  getEventScanStats
);

export default router;
