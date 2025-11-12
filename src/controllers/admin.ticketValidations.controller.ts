// src/controllers/admin.ticketValidations.controller.ts
import { Request, Response } from 'express';
import prisma from '../prisma/client';

/**
 * GET /api/admin/ticket-validations
 * 
 * Lista todas las validaciones de tickets (OWN y RESALE) con filtros
 * Parámetros query:
 * - eventId?: number
 * - eventType?: 'OWN' | 'RESALE'
 * - dateFrom?: ISO string
 * - dateTo?: ISO string
 * - page?: number (default 1)
 * - limit?: number (default 50)
 */
export async function listAllValidations(req: Request, res: Response) {
  try {
    const { eventId, eventType, dateFrom, dateTo, page = '1', limit = '50' } = req.query;

    const pageNum = Math.max(1, parseInt(page as string) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string) || 50));
    const skip = (pageNum - 1) * limitNum;

    // Construir filtros de fecha
    let dateFilter: any = {};
    if (dateFrom || dateTo) {
      dateFilter = {};
      if (dateFrom) dateFilter.gte = new Date(dateFrom as string);
      if (dateTo) dateFilter.lte = new Date(dateTo as string);
    }

    // ============ VALIDACIONES OWN ============
    let ownValidations: any[] = [];
    if (!eventType || eventType === 'OWN') {
      const ownFilter: any = {
        scanned: true,
      };

      if (dateFilter.gte || dateFilter.lte) {
        ownFilter.scannedAt = dateFilter;
      }

      if (eventId) {
        ownFilter.reservation = {
          event: {
            id: parseInt(eventId as string),
            eventType: 'OWN',
          },
        };
      } else {
        ownFilter.reservation = {
          event: {
            eventType: 'OWN',
          },
        };
      }

      const ownTickets = await prisma.generatedTicket.findMany({
        where: ownFilter,
        select: {
          id: true,
          ticketNumber: true,
          seatNumber: true,
          qrCode: true,
          scanned: true,
          scannedAt: true,
          scannedBy: true,
          reservation: {
            select: {
              id: true,
              code: true,
              buyer: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                },
              },
              event: {
                select: {
                  id: true,
                  title: true,
                  date: true,
                  location: true,
                  eventType: true,
                  organizer: {
                    select: {
                      id: true,
                      name: true,
                      email: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: {
          scannedAt: 'desc',
        },
        take: limitNum,
        skip: skip,
      });

      ownValidations = ownTickets.map((ticket) => ({
        type: 'OWN',
        ticketId: ticket.id,
        ticketNumber: ticket.ticketNumber,
        seatNumber: ticket.seatNumber,
        qrCode: ticket.qrCode,
        scannedAt: ticket.scannedAt,
        scannedBy: ticket.scannedBy,
        scannedCount: 1,
        event: {
          id: ticket.reservation.event.id,
          title: ticket.reservation.event.title,
          date: ticket.reservation.event.date,
          location: ticket.reservation.event.location,
          eventType: ticket.reservation.event.eventType,
          organizer: ticket.reservation.event.organizer,
        },
        buyer: ticket.reservation.buyer,
        reservationCode: ticket.reservation.code,
        logs: null,
      }));
    }

    // ============ VALIDACIONES RESALE ============
    let resaleValidations: any[] = [];
    if (!eventType || eventType === 'RESALE') {
      const resaleFilter: any = {
        scannedCount: {
          gt: 0,
        },
        sold: true,
      };

      if (dateFilter.gte || dateFilter.lte) {
        resaleFilter.lastScannedAt = dateFilter;
      }

      if (eventId) {
        resaleFilter.event = {
          id: parseInt(eventId as string),
          eventType: 'RESALE',
        };
      } else {
        resaleFilter.event = {
          eventType: 'RESALE',
        };
      }

      const resaleTickets = await prisma.ticket.findMany({
        where: resaleFilter,
        select: {
          id: true,
          ticketCode: true,
          row: true,
          seat: true,
          zone: true,
          level: true,
          proxyQrCode: true,
          scannedCount: true,
          lastScannedAt: true,
          scannedLogs: true,
          event: {
            select: {
              id: true,
              title: true,
              date: true,
              location: true,
              eventType: true,
              organizer: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                },
              },
            },
          },
          reservation: {
            select: {
              id: true,
              code: true,
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
        orderBy: {
          lastScannedAt: 'desc',
        },
        take: limitNum,
        skip: eventType === 'RESALE' ? skip : 0,
      });

      resaleValidations = resaleTickets.map((ticket) => ({
        type: 'RESALE',
        ticketId: ticket.id,
        ticketCode: ticket.ticketCode,
        seatInfo: `${ticket.row}-${ticket.seat}${ticket.zone ? ` (${ticket.zone})` : ''}`,
        row: ticket.row,
        seat: ticket.seat,
        zone: ticket.zone,
        level: ticket.level,
        proxyQrCode: ticket.proxyQrCode,
        scannedCount: ticket.scannedCount,
        lastScannedAt: ticket.lastScannedAt,
        event: {
          id: ticket.event.id,
          title: ticket.event.title,
          date: ticket.event.date,
          location: ticket.event.location,
          eventType: ticket.event.eventType,
          organizer: ticket.event.organizer,
        },
        buyer: ticket.reservation?.buyer || null,
        reservationCode: ticket.reservation?.code || null,
        logs: ticket.scannedLogs,
      }));
    }

    // Combinar y ordenar por fecha
    const allValidations = [...ownValidations, ...resaleValidations];
    allValidations.sort((a, b) => {
      const dateA = new Date(a.lastScannedAt || a.scannedAt);
      const dateB = new Date(b.lastScannedAt || b.scannedAt);
      return dateB.getTime() - dateA.getTime();
    });

    // Aplicar paginación combinada si no hay filtro de tipo
    const paginatedValidations = !eventType 
      ? allValidations.slice(0, limitNum)
      : allValidations;

    // Contar totales
    const totalOwnCount = !eventType || eventType === 'OWN'
      ? await prisma.generatedTicket.count({
          where: {
            scanned: true,
            reservation: {
              event: {
                eventType: 'OWN',
                ...(eventId && { id: parseInt(eventId as string) }),
              },
            },
          },
        })
      : 0;

    const totalResaleCount = !eventType || eventType === 'RESALE'
      ? await prisma.ticket.count({
          where: {
            scannedCount: { gt: 0 },
            sold: true,
            event: {
              eventType: 'RESALE',
              ...(eventId && { id: parseInt(eventId as string) }),
            },
          },
        })
      : 0;

    const totalCount = totalOwnCount + totalResaleCount;

    return res.json({
      validations: paginatedValidations,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limitNum),
        ownCount: totalOwnCount,
        resaleCount: totalResaleCount,
      },
    });

  } catch (error) {
    console.error('❌ Error al listar validaciones:', error);
    return res.status(500).json({ 
      error: 'Error al obtener las validaciones',
      message: 'Ocurrió un error al procesar la solicitud.',
    });
  }
}

/**
 * GET /api/admin/ticket-validations/:ticketId
 * 
 * Obtiene detalles de una validación específica
 * Query param: type ('OWN' | 'RESALE')
 */
export async function getValidationDetails(req: Request, res: Response) {
  try {
    const { ticketId } = req.params;
    const { type } = req.query;

    if (!ticketId) {
      return res.status(400).json({ error: 'ticketId es requerido' });
    }

    if (!type || (type !== 'OWN' && type !== 'RESALE')) {
      return res.status(400).json({ error: 'Parámetro "type" requerido (OWN o RESALE)' });
    }

    if (type === 'OWN') {
      const ticket = await prisma.generatedTicket.findUnique({
        where: { id: parseInt(ticketId) },
        include: {
          reservation: {
            include: {
              event: {
                include: {
                  organizer: {
                    select: {
                      id: true,
                      name: true,
                      email: true,
                    },
                  },
                },
              },
              buyer: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  rut: true,
                },
              },
            },
          },
        },
      });

      if (!ticket) {
        return res.status(404).json({ error: 'Ticket no encontrado' });
      }

      return res.json({
        type: 'OWN',
        ticket: {
          id: ticket.id,
          ticketNumber: ticket.ticketNumber,
          seatNumber: ticket.seatNumber,
          qrCode: ticket.qrCode,
          scanned: ticket.scanned,
          scannedAt: ticket.scannedAt,
          scannedBy: ticket.scannedBy,
        },
        event: ticket.reservation.event,
        buyer: ticket.reservation.buyer,
        reservation: {
          id: ticket.reservation.id,
          code: ticket.reservation.code,
          quantity: ticket.reservation.quantity,
          status: ticket.reservation.status,
          paidAt: ticket.reservation.paidAt,
        },
      });

    } else {
      // RESALE
      if (!ticketId) {
        return res.status(400).json({ error: 'ticketId es requerido' });
      }
      
      const ticket = await prisma.ticket.findUnique({
        where: { id: parseInt(ticketId) },
        include: {
          event: {
            include: {
              organizer: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                },
              },
            },
          },
          reservation: {
            include: {
              buyer: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  rut: true,
                },
              },
            },
          },
        },
      });

      if (!ticket) {
        return res.status(404).json({ error: 'Ticket no encontrado' });
      }

      return res.json({
        type: 'RESALE',
        ticket: {
          id: ticket.id,
          ticketCode: ticket.ticketCode,
          row: ticket.row,
          seat: ticket.seat,
          zone: ticket.zone,
          level: ticket.level,
          proxyQrCode: ticket.proxyQrCode,
          originalQrCode: ticket.originalQrCode,
          scannedCount: ticket.scannedCount,
          lastScannedAt: ticket.lastScannedAt,
          scannedLogs: ticket.scannedLogs,
        },
        event: ticket.event,
        buyer: ticket.reservation?.buyer || null,
        reservation: ticket.reservation ? {
          id: ticket.reservation.id,
          code: ticket.reservation.code,
          status: ticket.reservation.status,
          paidAt: ticket.reservation.paidAt,
        } : null,
      });
    }

  } catch (error) {
    console.error('❌ Error al obtener detalles de validación:', error);
    return res.status(500).json({ 
      error: 'Error al obtener los detalles',
      message: 'Ocurrió un error al procesar la solicitud.',
    });
  }
}
