// src/routes/payments.routes.ts
import { Router } from "express";
import {
  createPayment,
  commitPayment,
  getPaymentStatus,
  refundPayment,
  getMyPending,
  restartPayment,
  getPaymentByBuyOrder,
  capturePayment,
  listMyPayouts,
  payoutsWebhook, // webhook PSP
} from "../controllers/payments.controller";

import {
  getMyConnectedAccount,
  updateMyConnectedAccount,
} from "../controllers/payments.connectedAccount.controller";

import {
  authenticateToken,
  ensureActiveAccount,
  requireSuperadmin,
} from "../middleware/authMiddleware";

const router = Router();

/**
 * Crear transacción (requiere sesión válida y cuenta activa)
 * Body: { eventId: number, quantity: number }
 */
router.post("/create", authenticateToken, ensureActiveAccount, createPayment);

/**
 * Callback de Webpay (puede volver por POST o GET)
 * - éxito: token_ws
 * - abortado: TBK_TOKEN
 */
router.post("/commit", commitPayment);
router.get("/commit", commitPayment);

/**
 * Consulta la reserva pendiente del usuario para un evento.
 * GET /api/payments/my-pending?eventId=123
 */
router.get("/my-pending", authenticateToken, ensureActiveAccount, getMyPending);

/**
 * Reanuda pago reutilizando la MISMA reserva (si sigue vigente).
 * POST /api/payments/restart  { reservationId }
 */
router.post("/restart", authenticateToken, ensureActiveAccount, restartPayment);

/**
 * Estado por token (pública para pruebas)
 */
router.get("/status/:token", getPaymentStatus);

/**
 * Estado local por buyOrder (cuando no hubo token_ws)
 */
router.get("/by-order/:buyOrder", getPaymentByBuyOrder);

/**
 * Capturar una pre-autorización (cuando el admin aprueba el ticket)
 * Body: { reservationId: number }
 * Requiere superadmin.
 */
router.post("/capture", authenticateToken, requireSuperadmin, capturePayment);

/**
 * Reembolso (sólo superadmin)
 */
router.post("/refund", authenticateToken, requireSuperadmin, refundPayment);

/* ===================== Connected Account (organizador) ===================== */
router.get(
  "/connected-account",
  authenticateToken,
  ensureActiveAccount,
  getMyConnectedAccount
);

router.patch(
  "/connected-account",
  authenticateToken,
  ensureActiveAccount,
  updateMyConnectedAccount
);

/* ============================ Payouts (organizer) ========================= */
router.get(
  "/payouts/my",
  authenticateToken,
  ensureActiveAccount,
  listMyPayouts
);

/* ============================ Webhook de Payouts (PSP) ==================== */
/**
 * Webhook público (sin auth) para eventos del PSP:
 * POST /api/payments/payouts/webhook
 * Importante: en server.ts ya configuraste el parser con raw/verify para conservar req.rawBody.
 */
router.post("/payouts/webhook", payoutsWebhook);

export default router;














