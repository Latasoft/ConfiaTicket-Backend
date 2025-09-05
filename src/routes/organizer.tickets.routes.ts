// src/routes/organizer.tickets.routes.ts
// NO importes FileFilterCallback
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

const router = Router();

// Base de uploads (misma que en server.ts)
const UPLOADS_BASE = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(process.cwd(), "uploads");

// 👉 Guardamos tickets en PRIVADO (no público)
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

// Usa el tipo que provee Multer para fileFilter y NO pases Error
const fileFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
  if (allowed.has(file.mimetype)) {
    cb(null, true); // aceptar
  } else {
    cb(null, false); // rechazar silenciosamente
    // (_req as any).fileValidationError = "Tipo de archivo no permitido";
  }
};

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter,
});

// =====================
// RUTAS (montadas bajo /api/organizer en server.ts)
// =====================

// Listar reservas de eventos del organizador (para la tabla en la misma página)
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

export default router;







