// src/routes/tickets.routes.ts
import { Router } from "express";
import { authenticateToken } from "../middleware/authMiddleware";
import {
  buyerDownloadTicket,
  buyerPreviewTicketFile,   // ⬅️ nuevo (preview inline/attachment)
  getTicketFlowStatus,
  listMyTickets,
} from "../controllers/tickets.controller";

const router = Router();

// Montadas bajo /api/tickets en server.ts

// Listado de entradas del comprador autenticado
router.get("/my", authenticateToken, listMyTickets);

// Estado del flujo de ticket para una reserva
router.get("/:id/status", authenticateToken, getTicketFlowStatus);

// Preview del archivo (inline por defecto; ?mode=attachment para forzar descarga)
router.get("/:id/file", authenticateToken, buyerPreviewTicketFile);

// Descargar el archivo de la entrada (PDF/PNG/JPG)
router.get("/:id/download", authenticateToken, buyerDownloadTicket);

export default router;






