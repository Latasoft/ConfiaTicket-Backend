// src/controllers/resaleTicketValidation.controller.ts
import { Request, Response } from 'express';
import prisma from '../prisma/client';

/**
 * GET /api/resale-tickets/validate/:proxyQrCode
 * 
 * Endpoint público para validar tickets de reventa mediante QR proxy
 * 
 * Este endpoint:
 * 1. Registra el escaneo en la base de datos
 * 2. Incrementa el contador de escaneos
 * 3. Actualiza la fecha del último escaneo
 * 4. Agrega una entrada al log de escaneos
 * 5. Redirige al QR original o retorna los datos del ticket
 * 
 * Funcionamiento:
 * - El comprador recibe un ticket con un QR proxy (link único)
 * - Al escanear el QR proxy, se registra el escaneo
 * - El sistema muestra el QR original para acceso al evento
 */
export async function validateResaleTicket(req: Request, res: Response) {
  try {
    const { proxyQrCode } = req.params;

    if (!proxyQrCode || typeof proxyQrCode !== 'string') {
      return res.status(400).json({ 
        error: 'Código QR inválido',
        valid: false,
      });
    }

    // Buscar el ticket por el proxyQrCode
    const ticket = await prisma.ticket.findUnique({
      where: { proxyQrCode },
      include: {
        event: {
          select: {
            id: true,
            title: true,
            date: true,
            location: true,
            city: true,
            commune: true,
            eventType: true,
          },
        },
        reservation: {
          select: {
            id: true,
            code: true,
            status: true,
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
        message: 'Este código QR no corresponde a ningún ticket válido en nuestro sistema.',
      });
    }

    // Verificar que el ticket esté vendido
    if (!ticket.sold || !ticket.reservation) {
      return res.status(400).json({ 
        error: 'Ticket no válido',
        valid: false,
        message: 'Este ticket aún no ha sido vendido o no está activo.',
      });
    }

    // Verificar que la reserva esté pagada
    if (ticket.reservation.status !== 'PAID') {
      return res.status(400).json({ 
        error: 'Ticket no válido',
        valid: false,
        reason: 'payment_pending',
        message: 'La compra de este ticket aún no ha sido confirmada.',
        paymentStatus: ticket.reservation.status,
      });
    }

    // Capturar información del escaneo
    const now = new Date();
    const scanInfo = {
      timestamp: now.toISOString(),
      ip: req.ip || req.socket.remoteAddress || 'unknown',
      userAgent: req.get('user-agent') || 'unknown',
      // Se podría agregar geolocalización aquí si está disponible
    };

    // Obtener logs existentes
    const existingLogs = (ticket.scannedLogs as any[]) || [];
    const updatedLogs = [...existingLogs, scanInfo];

    // Actualizar el ticket con la información del escaneo
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        scannedCount: ticket.scannedCount + 1,
        lastScannedAt: now,
        scannedLogs: updatedLogs,
      },
    });

    console.log(`Ticket de reventa escaneado - Proxy: ${proxyQrCode}, Count: ${ticket.scannedCount + 1}`);

    // Preparar respuesta con información del ticket
    const response = {
      valid: true,
      message: 'Ticket validado correctamente',
      scannedCount: ticket.scannedCount + 1,
      lastScannedAt: now.toISOString(),
      ticket: {
        id: ticket.id,
        ticketCode: ticket.ticketCode,
        row: ticket.row,
        seat: ticket.seat,
        zone: ticket.zone,
        level: ticket.level,
      },
      event: {
        id: ticket.event.id,
        title: ticket.event.title,
        date: ticket.event.date,
        location: ticket.event.location,
        city: ticket.event.city,
        commune: ticket.event.commune,
      },
      buyer: ticket.reservation.buyer ? {
        name: ticket.reservation.buyer.name,
        email: ticket.reservation.buyer.email,
      } : null,
      reservationCode: ticket.reservation.code,
      originalQrCode: ticket.originalQrCode,
    };

    // Siempre devolver JSON con los datos
    // El frontend se encargará de mostrar el QR original
    return res.json(response);
    
  } catch (error) {
    console.error('❌ Error al validar ticket de reventa:', error);
    return res.status(500).json({ 
      error: 'Error al validar el ticket',
      valid: false,
      message: 'Ocurrió un error al procesar la validación. Por favor, intente nuevamente.',
    });
  }
}

/**
 * GET /api/resale-tickets/:proxyQrCode/stats
 * 
 * Obtener estadísticas de escaneos de un ticket específico
 * (Solo para el organizador del evento)
 */
export async function getTicketScanStats(req: Request, res: Response) {
  try {
    const user = (req as any).user as { id: number; role: string } | undefined;
    if (!user) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    const { proxyQrCode } = req.params;

    const ticket = await prisma.ticket.findUnique({
      where: { proxyQrCode },
      include: {
        event: {
          select: {
            id: true,
            title: true,
            organizerId: true,
          },
        },
      },
    });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket no encontrado' });
    }

    // Verificar que el usuario sea el organizador del evento
    if (ticket.event.organizerId !== user.id && user.role !== 'superadmin') {
      return res.status(403).json({ 
        error: 'No tienes permiso para ver las estadísticas de este ticket' 
      });
    }

    return res.json({
      ticketId: ticket.id,
      ticketCode: ticket.ticketCode,
      seat: `${ticket.row}${ticket.seat}`,
      zone: ticket.zone,
      level: ticket.level,
      event: {
        id: ticket.event.id,
        title: ticket.event.title,
      },
      stats: {
        scannedCount: ticket.scannedCount,
        lastScannedAt: ticket.lastScannedAt,
        sold: ticket.sold,
        soldAt: ticket.soldAt,
      },
      scanHistory: ticket.scannedLogs || [],
    });
    
  } catch (error) {
    console.error('❌ Error al obtener estadísticas:', error);
    return res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
}

/**
 * GET /api/resale-tickets/event/:eventId/scan-stats
 * 
 * Obtener estadísticas de escaneos de todos los tickets de un evento RESALE
 * (Solo para el organizador del evento)
 */
export async function getEventScanStats(req: Request, res: Response) {
  try {
    const user = (req as any).user as { id: number; role: string } | undefined;
    if (!user) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    const eventId = Number(req.params.eventId);

    // Verificar que el evento existe y pertenece al usuario
    const event = await prisma.event.findFirst({
      where: { 
        id: eventId,
        eventType: 'RESALE',
      },
      select: {
        id: true,
        title: true,
        organizerId: true,
      },
    });

    if (!event) {
      return res.status(404).json({ error: 'Evento no encontrado o no es de tipo RESALE' });
    }

    if (event.organizerId !== user.id && user.role !== 'superadmin') {
      return res.status(403).json({ 
        error: 'No tienes permiso para ver las estadísticas de este evento' 
      });
    }

    // Obtener todos los tickets del evento con sus estadísticas
    const tickets = await prisma.ticket.findMany({
      where: { eventId },
      include: {
        reservation: {
          select: {
            code: true,
            status: true,
            buyer: {
              select: {
                name: true,
                email: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const totalTickets = tickets.length;
    const soldTickets = tickets.filter(t => t.sold).length;
    const totalScans = tickets.reduce((sum, t) => sum + t.scannedCount, 0);
    const scannedTickets = tickets.filter(t => t.scannedCount > 0).length;

    return res.json({
      event: {
        id: event.id,
        title: event.title,
      },
      summary: {
        totalTickets,
        soldTickets,
        availableTickets: totalTickets - soldTickets,
        scannedTickets,
        totalScans,
      },
      tickets: tickets.map(ticket => ({
        id: ticket.id,
        ticketCode: ticket.ticketCode,
        seat: `${ticket.row}${ticket.seat}`,
        zone: ticket.zone,
        level: ticket.level,
        sold: ticket.sold,
        soldAt: ticket.soldAt,
        scannedCount: ticket.scannedCount,
        lastScannedAt: ticket.lastScannedAt,
        buyer: ticket.reservation?.buyer ? {
          name: ticket.reservation.buyer.name,
          email: ticket.reservation.buyer.email,
        } : null,
        reservationCode: ticket.reservation?.code,
      })),
    });
    
  } catch (error) {
    console.error('Error al obtener estadísticas del evento:', error);
    return res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
}
