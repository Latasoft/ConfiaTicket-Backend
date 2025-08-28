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

const router = Router();

// Listado de tickets pendientes de revisión
router.get("/tickets/pending", authenticateToken, requireSuperadmin, adminListPendingTickets);

// Preview/descarga del archivo de una reserva
router.get(
  "/reservations/:id/ticket-file",
  authenticateToken,
  requireSuperadmin,
  adminPreviewTicketFile
);

// Aprobar o rechazar ticket subido
router.post(
  "/reservations/:id/approve-ticket",
  authenticateToken,
  requireSuperadmin,
  adminApproveTicket
);
router.post(
  "/reservations/:id/reject-ticket",
  authenticateToken,
  requireSuperadmin,
  adminRejectTicket
);

// JOB: barrer reservas con plazo de subida vencido y reembolsar
router.post(
  "/tickets/sweep-overdue",
  authenticateToken,
  requireSuperadmin,
  sweepOverdueReservations
);

export default router;






