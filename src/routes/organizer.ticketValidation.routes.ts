// src/routes/organizer.ticketValidation.routes.ts
import { Router } from 'express';
import { authenticateToken } from '../middleware/authMiddleware';
import { requireVerifiedOrganizer } from '../middleware/authMiddleware';
import {
  validateTicket,
  checkTicket,
  getValidationStats,
  getValidatedTickets,
} from '../controllers/organizer.ticketValidation.controller';

const router = Router();

// Todas las rutas requieren autenticación y ser organizador verificado
router.use(authenticateToken);
router.use(requireVerifiedOrganizer);

// POST /api/organizer/ticket-validation/validate
// Validar un ticket (marcarlo como escaneado)
router.post('/validate', validateTicket);

// GET /api/organizer/ticket-validation/check/:qrCode
// Consultar estado de un ticket sin marcarlo
router.get('/check/:qrCode', checkTicket);

// GET /api/organizer/ticket-validation/events/:eventId/stats
// Obtener estadísticas de validación de un evento
router.get('/events/:eventId/stats', getValidationStats);

// GET /api/organizer/ticket-validation/validated-tickets
// Listar tickets validados con filtros y paginación
router.get('/validated-tickets', getValidatedTickets);

export default router;
