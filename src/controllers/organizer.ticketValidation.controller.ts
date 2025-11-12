// src/controllers/organizer.ticketValidation.controller.ts
import { Request, Response } from 'express';
import prisma from '../prisma/client';

type Authed = { id: number; role: string };

/**
 * POST /api/organizer/ticket-validation/validate
 * Body: { qrCode: string }
 * 
 * Valida un ticket QR para uno de los eventos del organizador
 * - Marca el ticket como escaneado
 * - Solo permite validar tickets de eventos propios
 * - Verifica que la reserva esté pagada
 */
export async function validateTicket(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const { qrCode, eventId } = req.body;

  if (!qrCode || typeof qrCode !== 'string') {
    return res.status(400).json({ error: 'qrCode es requerido' });
  }

  // Buscar el ticket generado con su reserva y evento
  const ticket = await prisma.generatedTicket.findUnique({
    where: { qrCode },
    include: {
      reservation: {
        select: {
          id: true,
          code: true,
          quantity: true,
          status: true,
          event: {
            select: {
              id: true,
              title: true,
              date: true,
              location: true,
              organizerId: true,
              eventType: true,
            },
          },
          buyer: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      },
    },
  });

  if (!ticket) {
    return res.status(404).json({ 
      error: 'Ticket no encontrado',
      valid: false,
    });
  }

  // Verificar que el evento NO es de tipo RESALE
  if (ticket.reservation.event.eventType === 'RESALE') {
    return res.status(400).json({ 
      error: 'Los tickets de reventa no se validan desde aquí',
      valid: false,
      reason: 'resale_ticket',
      message: 'Los tickets de reventa se validan automáticamente cuando el comprador escanea el QR proxy. Puedes ver las estadísticas en la sección de estadísticas del evento.',
    });
  }

  // Verificar que el evento pertenece al organizador
  if (ticket.reservation.event.organizerId !== user.id) {
    return res.status(403).json({ 
      error: 'No tienes permiso para validar este ticket',
      valid: false,
      reason: 'not_your_event',
    });
  }

  // NUEVA VALIDACIÓN: Verificar que el ticket pertenece al evento seleccionado
  if (eventId && ticket.reservation.event.id !== Number(eventId)) {
    return res.status(200).json({ 
      error: 'Este ticket pertenece a otro evento',
      valid: false,
      reason: 'wrong_event',
      ticketEvent: {
        id: ticket.reservation.event.id,
        title: ticket.reservation.event.title,
      },
    });
  }

  // Verificar que la reserva está pagada
  if (ticket.reservation.status !== 'PAID') {
    return res.status(200).json({ 
      error: 'La reserva no está pagada',
      valid: false,
      reason: 'payment_pending',
      paymentStatus: ticket.reservation.status,
    });
  }

  // Verificar si ya fue escaneado
  if (ticket.scanned) {
    return res.status(200).json({ 
      error: 'Ticket ya fue utilizado',
      valid: false,
      reason: 'already_scanned',
      scannedAt: ticket.scannedAt,
      scannedBy: ticket.scannedBy,
    });
  }

  // Marcar como escaneado
  const updated = await prisma.generatedTicket.update({
    where: { id: ticket.id },
    data: {
      scanned: true,
      scannedAt: new Date(),
      scannedBy: user.id.toString(),
    },
  });

  return res.json({
    valid: true,
    message: 'Ticket validado correctamente',
    ticket: {
      id: ticket.id,
      ticketNumber: ticket.ticketNumber,
      seatNumber: ticket.seatNumber,
      scannedAt: updated.scannedAt,
    },
    event: {
      id: ticket.reservation.event.id,
      title: ticket.reservation.event.title,
      date: ticket.reservation.event.date,
      location: ticket.reservation.event.location,
    },
    buyer: {
      name: ticket.reservation.buyer.name,
      email: ticket.reservation.buyer.email,
    },
    reservation: {
      id: ticket.reservation.id,
      reservationCode: ticket.reservation.code,
      totalTickets: ticket.reservation.quantity,
    },
  });
}

/**
 * GET /api/organizer/ticket-validation/check/:qrCode
 * 
 * Consulta el estado de un ticket SIN marcarlo como escaneado
 * Útil para pre-verificación
 */
export async function checkTicket(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const { qrCode } = req.params;

  if (!qrCode) {
    return res.status(400).json({ error: 'qrCode es requerido' });
  }

  const ticket = await prisma.generatedTicket.findUnique({
    where: { qrCode },
    include: {
      reservation: {
        select: {
          id: true,
          code: true,
          quantity: true,
          status: true,
          event: {
            select: {
              id: true,
              title: true,
              date: true,
              location: true,
              organizerId: true,
            },
          },
          buyer: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      },
    },
  });

  if (!ticket) {
    return res.status(404).json({ 
      valid: false,
      reason: 'not_found',
    });
  }

  if (ticket.reservation.event.organizerId !== user.id) {
    return res.status(403).json({ 
      valid: false,
      reason: 'not_your_event',
    });
  }

  return res.json({
    valid: ticket.reservation.status === 'PAID' && !ticket.scanned,
    scanned: ticket.scanned,
    scannedAt: ticket.scannedAt,
    paymentStatus: ticket.reservation.status,
    event: {
      id: ticket.reservation.event.id,
      title: ticket.reservation.event.title,
      date: ticket.reservation.event.date,
    },
    buyer: {
      name: ticket.reservation.buyer.name,
    },
    ticketNumber: ticket.ticketNumber,
    seatNumber: ticket.seatNumber,
  });
}

/**
 * GET /api/organizer/ticket-validation/events/:eventId/stats
 * 
 * Estadísticas de validación para un evento específico
 */
export async function getValidationStats(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const eventId = Number(req.params.eventId);

  // Verificar que el evento pertenece al organizador
  const event = await prisma.event.findFirst({
    where: { id: eventId, organizerId: user.id },
    select: {
      id: true,
      title: true,
      capacity: true,
    },
  });

  if (!event) {
    return res.status(404).json({ error: 'Evento no encontrado' });
  }

  // Contar tickets totales vendidos (pagados)
  const totalTickets = await prisma.generatedTicket.count({
    where: {
      reservation: {
        eventId,
        status: 'PAID',
      },
    },
  });

  // Contar tickets validados
  const scannedTickets = await prisma.generatedTicket.count({
    where: {
      reservation: {
        eventId,
        status: 'PAID',
      },
      scanned: true,
    },
  });

  return res.json({
    eventId: event.id,
    eventTitle: event.title,
    capacity: event.capacity,
    totalTickets,
    scannedTickets,
    pendingTickets: totalTickets - scannedTickets,
    scanProgress: totalTickets > 0 ? (scannedTickets / totalTickets * 100).toFixed(1) : '0.0',
  });
}

/**
 * GET /api/organizer/ticket-validation/validated-tickets
 * Query params: eventId?, page?, pageSize?, startDate?, endDate?
 * 
 * Lista de tickets validados con filtros y paginación
 */
export async function getValidatedTickets(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const {
    eventId,
    page = '1',
    pageSize = '20',
    startDate,
    endDate,
  } = req.query;

  const pageNum = Math.max(1, parseInt(page as string));
  const pageSizeNum = Math.min(100, Math.max(1, parseInt(pageSize as string)));
  const skip = (pageNum - 1) * pageSizeNum;

  // Construir filtros
  const where: any = {
    scanned: true,
    reservation: {
      event: {
        organizerId: user.id,
      },
    },
  };

  // Filtro por evento específico
  if (eventId) {
    where.reservation.eventId = Number(eventId);
  }

  // Filtro por rango de fechas de escaneo
  if (startDate || endDate) {
    where.scannedAt = {};
    if (startDate) {
      where.scannedAt.gte = new Date(startDate as string);
    }
    if (endDate) {
      const end = new Date(endDate as string);
      end.setHours(23, 59, 59, 999);
      where.scannedAt.lte = end;
    }
  }

  // Obtener tickets validados con paginación
  const [tickets, total] = await Promise.all([
    prisma.generatedTicket.findMany({
      where,
      include: {
        reservation: {
          select: {
            code: true,
            event: {
              select: {
                id: true,
                title: true,
                date: true,
              },
            },
            buyer: {
              select: {
                name: true,
                email: true,
              },
            },
          },
        },
      },
      orderBy: {
        scannedAt: 'desc',
      },
      skip,
      take: pageSizeNum,
    }),
    prisma.generatedTicket.count({ where }),
  ]);

  return res.json({
    items: tickets.map(ticket => ({
      id: ticket.id,
      qrCode: ticket.qrCode,
      ticketNumber: ticket.ticketNumber,
      seatNumber: ticket.seatNumber,
      scannedAt: ticket.scannedAt,
      scannedBy: ticket.scannedBy,
      event: {
        id: ticket.reservation.event.id,
        title: ticket.reservation.event.title,
        date: ticket.reservation.event.date,
      },
      buyer: {
        name: ticket.reservation.buyer.name,
        email: ticket.reservation.buyer.email,
      },
      reservationCode: ticket.reservation.code,
    })),
    pagination: {
      page: pageNum,
      pageSize: pageSizeNum,
      total,
      totalPages: Math.ceil(total / pageSizeNum),
    },
  });
}
