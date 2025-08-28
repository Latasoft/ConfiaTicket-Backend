// src/routes/admin.organizerApplications.routes.ts
import { Router } from "express";
import {
  adminListOrganizerApplications,
  adminApproveOrganizerApplication,
  adminRejectOrganizerApplication,
  adminReopenOrganizerApplication,
} from "../controllers/admin.organizerApplications.controller";
import { authenticateToken, authorizeRoles } from "../middleware/authMiddleware";

const router = Router();

// Solo SUPERADMIN
router.use(authenticateToken, authorizeRoles("superadmin"));

// (Opcional) guard sencillo para validar :id numérico
router.param("id", (req, res, next, rawId) => {
  const id = Number(rawId);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "ID inválido" });
  }
  next();
});

// Listar con filtros/paginación
router.get("/", adminListOrganizerApplications);

// Aprobar, Rechazar y Reabrir
router.post("/:id/approve", adminApproveOrganizerApplication);
router.post("/:id/reject", adminRejectOrganizerApplication);
router.post("/:id/reopen", adminReopenOrganizerApplication);

export default router;



