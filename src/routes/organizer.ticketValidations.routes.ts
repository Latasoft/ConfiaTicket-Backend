// src/routes/organizer.ticketValidations.routes.ts
import { Router } from 'express';
import {
  listOrganizerValidations,
  getOrganizerValidationDetails,
} from '../controllers/organizer.ticketValidations.controller';
import { authenticateToken, requireVerifiedOrganizer } from '../middleware/authMiddleware';

const router = Router();

// Todas las rutas requieren autenticación y ser organizador verificado
router.use(authenticateToken);
router.use(requireVerifiedOrganizer);

// GET /api/organizer/ticket-validations
// Lista las validaciones del organizador con filtros
router.get('/', listOrganizerValidations);

// GET /api/organizer/ticket-validations/:ticketId
// Obtiene detalles de una validación específica
router.get('/:ticketId', getOrganizerValidationDetails);

export default router;
