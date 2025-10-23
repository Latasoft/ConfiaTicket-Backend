// src/routes/admin.users.routes.ts
import { Router } from "express";
import {
  adminListUsers,
  adminGetUser,
  adminSetUserCanSell,
  adminActivateUser,
  adminDeactivateUser,
  adminDeleteUserPreview,
  adminSoftDeleteUser,
} from "../controllers/admin.users.controller";

const router = Router();

/**
 * Base esperada de montaje (ejemplo):
 * app.use("/api/admin/users", router)
 */

// Listado
router.get("/", adminListUsers);

// Detalle de un usuario específico
router.get("/:id", adminGetUser);

// Permiso de venta (toggle)
router.post("/:id/can-sell", adminSetUserCanSell);

// Activar / Desactivar cuenta
router.post("/:id/activate", adminActivateUser);
router.post("/:id/deactivate", adminDeactivateUser);

// Preview de eliminación y soft-delete
router.get("/:id/delete-preview", adminDeleteUserPreview);
router.post("/:id/soft-delete", adminSoftDeleteUser);

export default router;



