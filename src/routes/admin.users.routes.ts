// src/routes/admin.users.routes.ts
import { Router } from "express";
import {
  adminListUsers,
  adminSetUserVerified,
  adminSetUserCanSell,
  adminDeactivateUser,
  adminActivateUser,
  adminDeleteUserPreview,
  adminSoftDeleteUser,
} from "../controllers/admin.users.controller";
import { authenticateToken, authorizeRoles } from "../middleware/authMiddleware";

const router = Router();

// Solo SUPERADMIN
router.use(authenticateToken, authorizeRoles("superadmin"));

// Listado
router.get("/", adminListUsers);

// Verificación y permiso de venta
router.patch("/:id/verified", adminSetUserVerified);
router.patch("/:id/can-sell", adminSetUserCanSell);

// Activar / Desactivar
router.post("/:id/deactivate", adminDeactivateUser);
router.post("/:id/activate", adminActivateUser);

// Preview de eliminación y Soft delete
router.get("/:id/delete-preview", adminDeleteUserPreview);
router.post("/:id/soft-delete", adminSoftDeleteUser);

export default router;


