// src/routes/tickets.routes.ts
import { Router } from "express";
import { authenticateToken } from "../middleware/authMiddleware";
import {
  buyerDownloadTicket,
  buyerPreviewTicketFile,
  getTicketFlowStatus,
  listMyTickets,
  // 👇 nuevas
  getReservationDetail,
  refreshReservationPayment,
  refreshReservationTicket,
} from "../controllers/tickets.controller";

const router = Router();

// Montadas bajo /api/tickets en server.ts

// Mis entradas (comprador)
router.get("/my", authenticateToken, listMyTickets);

// Estado del flujo de ticket para una reserva
router.get("/:id/status", authenticateToken, getTicketFlowStatus);

// Vista previa del archivo (inline por defecto; ?mode=attachment para forzar descarga)
router.get("/:id/file", authenticateToken, buyerPreviewTicketFile);

// Descargar el archivo de la entrada (PDF/PNG/JPG)
router.get("/:id/download", authenticateToken, buyerDownloadTicket);

// ========= NUEVAS RUTAS DE SEGUIMIENTO DE RESERVA =========

// Detalle completo de la reserva (comprador/admin)
router.get("/reservations/:id", authenticateToken, getReservationDetail);

// Refrescar estado del pago (consulta al PSP) y devolver detalle actualizado
router.post("/reservations/:id/refresh-payment", authenticateToken, refreshReservationPayment);

// Refrescar/consultar estado del flujo del ticket y devolverlo
router.post("/reservations/:id/refresh-ticket", authenticateToken, refreshReservationTicket);

export default router;








