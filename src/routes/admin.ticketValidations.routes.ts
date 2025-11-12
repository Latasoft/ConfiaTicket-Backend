// src/routes/admin.ticketValidations.routes.ts
import { Router } from 'express';
import {
  listAllValidations,
  getValidationDetails,
} from '../controllers/admin.ticketValidations.controller';
import { authenticateToken, authorizeRoles } from '../middleware/authMiddleware';

const router = Router();

// Sólo superadmin
router.use(authenticateToken, authorizeRoles('superadmin'));

// GET /api/admin/ticket-validations
// Lista todas las validaciones con filtros
router.get('/', listAllValidations);

// GET /api/admin/ticket-validations/:ticketId
// Obtiene detalles de una validación específica
router.get('/:ticketId', getValidationDetails);

export default router;
