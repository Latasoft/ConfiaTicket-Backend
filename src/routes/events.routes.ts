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
 * Rutas públicas para secciones y asientos
 * — van ANTES de '/:id' para evitar conflictos
 */
// Obtener secciones de un evento OWN
router.get('/:id/sections', async (req, res) => {
  try {
    const eventId = Number(req.params.id);
    console.log('🔍 [DEBUG] GET /events/:id/sections - eventId:', eventId);
    
    const prismaClient = (await import('../prisma/client')).default;
    
    // Verificar que el evento exista y su tipo
    const event = await prismaClient.event.findUnique({
      where: { id: eventId },
      select: { id: true, title: true, eventType: true }
    });
    
    console.log('🔍 [DEBUG] Evento encontrado:', event);
    
    const sections = await prismaClient.eventSection.findMany({
      where: { eventId },
      orderBy: { createdAt: 'asc' },
    });
    
    console.log('🔍 [DEBUG] Secciones encontradas:', sections.length);
    
    // Calcular asientos disponibles por sección
    const now = new Date();
    const HOLD_MS = 15 * 60 * 1000; // 15 minutos
    
    const sectionsWithAvailability = await Promise.all(
      sections.map(async (section) => {
        // Contar reservas activas (pagadas o pendientes dentro del hold)
        const reservedInSection = await prismaClient.reservation.aggregate({
          where: {
            eventId,
            sectionId: section.id,
            status: { in: ['PAID', 'PENDING_PAYMENT'] },
            // Solo contar pendientes que aún están en hold
            OR: [
              { status: 'PAID' },
              { 
                status: 'PENDING_PAYMENT',
                expiresAt: { gt: now },
                createdAt: { gt: new Date(now.getTime() - HOLD_MS) }
              }
            ]
          },
          _sum: { quantity: true },
        });
        
        const reserved = reservedInSection._sum.quantity || 0;
        const available = Math.max(0, section.totalCapacity - reserved);
        
        return {
          ...section,
          reserved,
          available,
        };
      })
    );
    
    console.log('🔍 [DEBUG] Secciones con disponibilidad:', 
      sectionsWithAvailability.map(s => ({ 
        name: s.name, 
        total: s.totalCapacity, 
        reserved: s.reserved, 
        available: s.available 
      }))
    );
    
    res.json(sectionsWithAvailability);
  } catch (err) {
    console.error('❌ [ERROR] Error al obtener secciones:', err);
    res.status(500).json({ error: 'Error al obtener secciones' });
  }
});

// Obtener asientos ocupados de una sección específica
router.get('/:id/sections/:sectionId/occupied-seats', async (req, res) => {
  try {
    const eventId = Number(req.params.id);
    const sectionId = Number(req.params.sectionId);
    
    const prismaClient = (await import('../prisma/client')).default;
    
    // Obtener todas las reservas pagadas o pendientes de pago con asientos asignados
    const reservations = await prismaClient.reservation.findMany({
      where: {
        eventId,
        sectionId,
        status: {
          in: ['PAID', 'PENDING_PAYMENT']
        },
        seatAssignment: {
          not: null
        }
      },
      select: {
        seatAssignment: true
      }
    });
    
    // Extraer todos los asientos ocupados
    const occupiedSeats = new Set<string>();
    for (const reservation of reservations) {
      if (reservation.seatAssignment) {
        const seats = reservation.seatAssignment.split(',').map(s => s.trim());
        seats.forEach(seat => occupiedSeats.add(seat));
      }
    }
    
    res.json({ occupiedSeats: Array.from(occupiedSeats) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener asientos ocupados' });
  }
});

// Obtener tickets RESALE disponibles de un evento
router.get('/:id/resale-tickets', async (req, res) => {
  try {
    const eventId = Number(req.params.id);
    const tickets = await (await import('../prisma/client')).default.ticket.findMany({
      where: {
        eventId,
        sold: false,
        reservationId: null, // Solo tickets sin reserva activa
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        ticketCode: true,
        row: true,
        seat: true,
        zone: true,
        level: true,
        sold: true,
        createdAt: true,
        updatedAt: true,
        // NO exponer las rutas de imagen por seguridad
        imageFilePath: false,
        imageFileName: true,
        imageMime: true,
      },
    });
    res.json(tickets);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener tickets' });
  }
});

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













