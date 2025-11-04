// src/routes/organizer.resaleTickets.routes.ts
// Rutas para gestión de tickets de reventa (resale)
import multer from "multer";
import path from "path";
import fs from "fs";
import { Router } from "express";
import {
  authenticateToken,
  requireVerifiedOrganizer,
} from "../middleware/authMiddleware";
import {
  organizerUploadTicket,
  organizerListReservations,
} from "../controllers/tickets.controller";
import {
  createTicket,
  listTickets,
  getTicket,
  updateTicket,
  deleteTicket,
} from "../controllers/organizer.resaleTickets.controller";

const router = Router();

// base de uploads (la misma que en server.ts)
const UPLOADS_BASE = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(process.cwd(), "uploads");

// los tickets se guardan en private
const TICKETS_DIR = path.join(UPLOADS_BASE, "private", "tickets");
fs.mkdirSync(TICKETS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TICKETS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, name);
  },
});

const allowed = new Set(["application/pdf", "image/png", "image/jpeg"]);

const fileFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
  if (allowed.has(file.mimetype)) {
    cb(null, true); // aceptar
  } else {
    cb(null, false); // rechazar 
  }
};

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter,
});

// =====================
// RUTAS /api/organizer en server.ts)
// =====================

// obtener reservas de eventos del organizador
router.get(
  "/reservations",
  authenticateToken,
  requireVerifiedOrganizer,
  organizerListReservations
);

// Subir archivo de ticket para una reserva concreta
router.post(
  "/reservations/:id/ticket",
  authenticateToken,
  requireVerifiedOrganizer,
  upload.single("ticket"),
  organizerUploadTicket
);

router.post(
  "/events/:eventId/tickets",
  authenticateToken,
  requireVerifiedOrganizer,
  upload.single("file"),
  createTicket
);

router.get(
  "/events/:eventId/tickets",
  authenticateToken,
  requireVerifiedOrganizer,
  listTickets
);

router.get(
  "/events/:eventId/tickets/:ticketId",
  authenticateToken,
  requireVerifiedOrganizer,
  getTicket
);

router.put(
  "/events/:eventId/tickets/:ticketId",
  authenticateToken,
  requireVerifiedOrganizer,
  updateTicket
);

router.delete(
  "/events/:eventId/tickets/:ticketId",
  authenticateToken,
  requireVerifiedOrganizer,
  deleteTicket
);

export default router;







