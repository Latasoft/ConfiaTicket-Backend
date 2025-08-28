// src/routes/payments.routes.ts
import { Router } from 'express';
import {
  createPayment,
  commitPayment,
  getPaymentStatus,
  refundPayment,
  getMyPending,            // ✅ nombre correcto (antes getMyPendingPending)
  restartPayment,
  getPaymentByBuyOrder,    // ✅ estado local por buyOrder
} from '../controllers/payments.controller';

import {
  authenticateToken,
  ensureActiveAccount,
  requireSuperadmin,
} from '../middleware/authMiddleware';

const router = Router();

/**
 * Crear transacción (requiere sesión válida y cuenta activa)
 * Body: { eventId: number, quantity: number }
 */
router.post('/create', authenticateToken, ensureActiveAccount, createPayment);

/**
 * Webpay puede volver por POST o GET (bancos/sandbox varían)
 * - éxito: token_ws
 * - abortado: TBK_TOKEN
 */
router.post('/commit', commitPayment);
router.get('/commit', commitPayment);

/**
 * Consulta la reserva pendiente del usuario para un evento.
 * GET /api/payments/my-pending?eventId=123
 */
router.get('/my-pending', authenticateToken, ensureActiveAccount, getMyPending);

/**
 * Reanuda pago reutilizando la MISMA reserva (si sigue vigente).
 * POST /api/payments/restart  { reservationId }
 */
router.post('/restart', authenticateToken, ensureActiveAccount, restartPayment);

/**
 * Estado por token (pública para pruebas)
 */
router.get('/status/:token', getPaymentStatus);

/**
 * Estado local por buyOrder (útil cuando el retorno fue abortado y no hay token_ws)
 */
router.get('/by-order/:buyOrder', getPaymentByBuyOrder);

/**
 * Reembolso (sólo superadmin)
 */
router.post('/refund', authenticateToken, ensureActiveAccount, requireSuperadmin, refundPayment);

export default router;







