// src/routes/admin.tickets.routes.ts
import { Router } from "express";
import {
  adminApproveTicket,
  adminListPendingTickets,
  adminRejectTicket,
  adminPreviewTicketFile,   // <- preview/descarga de archivo
  sweepOverdueReservations, // <- barrido de reservas vencidas + reembolso
} from "../controllers/tickets.controller";
import { authenticateToken, requireSuperadmin } from "../middleware/authMiddleware";

// NUEVO: importamos el controlador todo-en-uno desde payments.controller
import { adminApproveAndCapture } from "../controllers/payments.controller";

const router = Router();

// Listado de tickets pendientes de revisión
router.get(
  "/tickets/pending",
  authenticateToken,
  requireSuperadmin,
  adminListPendingTickets
);

// Preview/descarga del archivo de una reserva
router.get(
  "/reservations/:id/ticket-file",
  authenticateToken,
  requireSuperadmin,
  adminPreviewTicketFile
);

// Aprobar SOLO (flujo antiguo, se mantiene como fallback)
router.post(
  "/reservations/:id/approve-ticket",
  authenticateToken,
  requireSuperadmin,
  adminApproveTicket
);

// Rechazar
router.post(
  "/reservations/:id/reject-ticket",
  authenticateToken,
  requireSuperadmin,
  adminRejectTicket
);

// NUEVO: Aprobar + Capturar + Crear payout (todo en uno)
router.post(
  "/reservations/:id/approve-and-capture",
  authenticateToken,
  requireSuperadmin,
  adminApproveAndCapture
);

// JOB: barrer reservas con plazo de subida vencido y reembolsar
router.post(
  "/tickets/sweep-overdue",
  authenticateToken,
  requireSuperadmin,
  sweepOverdueReservations
);

export default router;








