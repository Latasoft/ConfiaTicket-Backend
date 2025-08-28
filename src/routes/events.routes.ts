// src/routes/events.routes.ts
import { Router } from 'express';
import {
  authenticateToken,
  authorizeRoles,
  requireVerifiedOrganizer,
  ensureActiveAccount,
} from '../middleware/authMiddleware';
import {
  createEvent,
  approveEvent,
  listPublicEvents,
  listOrganizerEvents,
  listPendingEvents,
  getEventDetails,
  updateEvent,
  deleteEvent,
  purchaseTickets,
} from '../controllers/events.controller';

const router = Router();

/**
 * Rutas públicas (primero, para no colisionar)
 */
router.get('/public-events', listPublicEvents);

/**
 * Compra de entradas (usuario autenticado)
 * — sin regex en el path, validamos el ID en el controller
 * — va ANTES de '/:id'
 */
router.post('/:id/purchase', authenticateToken, ensureActiveAccount, purchaseTickets);

/**
 * Listado del organizador autenticado
 * — va ANTES de '/:id'
 */
router.get(
  '/my-events',
  authenticateToken,
  authorizeRoles('organizer'),
  listOrganizerEvents
);

/**
 * Detalle público por id (simple)
 * — esta ruta va DESPUÉS de las específicas de arriba
 */
router.get('/:id', getEventDetails);

/**
 * Crear/editar/eliminar eventos (organizador verificado o superadmin)
 */
router.post('/', authenticateToken, requireVerifiedOrganizer, createEvent);

router.put(
  '/:id',
  authenticateToken,
  requireVerifiedOrganizer,
  updateEvent
);

router.delete(
  '/:id',
  authenticateToken,
  requireVerifiedOrganizer,
  deleteEvent
);

/**
 * Rutas de administración (solo superadmin)
 * — Declararlas ANTES de '/:id' público si las montaras en el mismo router
 *   (en este caso van bajo /api/admin/events, así que no colisionan)
 */
router.get(
  '/pending-events',
  authenticateToken,
  authorizeRoles('superadmin'),
  listPendingEvents
);

router.patch(
  '/:id/approve',
  authenticateToken,
  authorizeRoles('superadmin'),
  approveEvent
);

export default router;












