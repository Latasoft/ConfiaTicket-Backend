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
  getEventDetails,
  updateEvent,
  deleteEvent,
  purchaseTickets,
  listPendingEvents,
} from '../controllers/events.controller';

const router = Router();

/**
 * Rutas públicas (primero, para no colisionar con `/:id`)
 */
router.get('/public', listPublicEvents);        // alias nuevo
router.get('/public-events', listPublicEvents); // compatibilidad

/**
 * Rutas de administración dentro de este router
 * (si las necesitas aquí). También van ANTES de `/:id`.
 * Nota: si ya las montas bajo /api/admin/events, puedes
 * quitar estas para evitar duplicados.
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

/**
 * Compra de entradas (usuario autenticado)
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
 * Detalle público por id
 * — debe quedar al final de las GET específicas
 */
router.get('/:id', getEventDetails);

/**
 * Crear/editar/eliminar (organizador verificado)
 */
router.post('/', authenticateToken, requireVerifiedOrganizer, createEvent);
router.put('/:id', authenticateToken, requireVerifiedOrganizer, updateEvent);
router.delete('/:id', authenticateToken, requireVerifiedOrganizer, deleteEvent);

export default router;













