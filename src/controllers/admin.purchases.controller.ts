// src/controllers/admin.purchases.controller.ts
import { Request, Response } from 'express';
import prisma from '../prisma/client';

/**
 * Lista todas las compras/reservas con filtros y paginación
 * GET /api/admin/purchases
 */
export async function adminListPurchases(req: Request, res: Response) {
  try {
    const {
      page = '1',
      pageSize = '20',
      q,
      eventId,
      status,
      eventType,
      dateFrom,
      dateTo,
    } = req.query;

    const pageNum = parseInt(page as string);
    const pageSizeNum = parseInt(pageSize as string);
    const skip = (pageNum - 1) * pageSizeNum;

    const where: any = {};

    // Búsqueda por ID, email o nombre del comprador
    if (q && typeof q === 'string') {
      const searchTerm = q.trim();
      where.OR = [
        { buyer: { email: { contains: searchTerm, mode: 'insensitive' } } },
        { buyer: { name: { contains: searchTerm, mode: 'insensitive' } } },
      ];
      
      // Si es un número, buscar también por ID
      if (!isNaN(Number(searchTerm))) {
        where.OR.push({ id: Number(searchTerm) });
      }
    }

    // Filtro por evento
    if (eventId) {
      where.eventId = Number(eventId);
    }

    // Filtro por estado de reserva - mapear status del frontend a valores válidos del schema
    if (status && typeof status === 'string') {
      const statusUpper = status.toUpperCase();
      // Mapeo de status del frontend a ReservationStatus del schema
      const validStatuses: Record<string, string> = {
        'PENDING_PAYMENT': 'PENDING_PAYMENT',
        'PENDING': 'PENDING_PAYMENT',
        'PAID': 'PAID',
        'SUCCEEDED': 'PAID', // Mapeo de status legacy del frontend
        'CANCELED': 'CANCELED',
        'CANCELLED': 'CANCELED',
        'EXPIRED': 'EXPIRED',
        // Los siguientes no existen en ReservationStatus, se filtrarán por Payment.status o RefundStatus
      };

      if (validStatuses[statusUpper]) {
        where.status = validStatuses[statusUpper];
      } else if (statusUpper === 'FAILED' || statusUpper === 'REFUNDED') {
        // Para FAILED y REFUNDED, filtrar por payment.status o refundStatus en lugar de reservation.status
        if (statusUpper === 'REFUNDED') {
          where.refundStatus = 'SUCCEEDED';
        } else if (statusUpper === 'FAILED') {
          // Buscar por payment.status = FAILED
          where.payment = { status: 'FAILED' };
        }
      }
      // Si no es un status válido, ignorar el filtro
    }

    // Filtro por rango de fechas
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) {
        where.createdAt.gte = new Date(dateFrom as string);
      }
      if (dateTo) {
        where.createdAt.lte = new Date(dateTo as string);
      }
    }

    // Filtro por tipo de evento (OWN o RESALE)
    if (eventType && typeof eventType === 'string') {
      where.event = { eventType };
    }

    // Ejecutar consultas en paralelo
    const [purchases, total] = await Promise.all([
      prisma.reservation.findMany({
        where,
        include: {
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
              eventType: true,
              date: true,
              organizer: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
          payment: {
            select: {
              id: true,
              status: true,
              amount: true,
              buyOrder: true,
              createdAt: true,
            },
          },
          generatedTickets: {
            select: {
              id: true,
              ticketNumber: true,
              qrCode: true,
              scanned: true,
              seatNumber: true,
            },
          },
          ticket: {
            select: {
              id: true,
              row: true,
              seat: true,
              zone: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSizeNum,
      }),
      prisma.reservation.count({ where }),
    ]);

    // Calcular métricas - usar el where original pero sin el filtro de status específico
    // para que las métricas sean más generales
    const metricsWhere = { ...where };
    // Remover filtro de status específico para métricas generales
    if (metricsWhere.status) {
      delete metricsWhere.status;
    }
    if (metricsWhere.payment) {
      delete metricsWhere.payment;
    }
    if (metricsWhere.refundStatus) {
      delete metricsWhere.refundStatus;
    }

    const [totalAmountResult, succeededCount] = await Promise.all([
      prisma.reservation.aggregate({
        where: metricsWhere,
        _sum: { amount: true },
      }),
      prisma.reservation.count({
        where: { ...metricsWhere, status: 'PAID' },
      }),
    ]);

    res.json({
      items: purchases,
      total,
      page: pageNum,
      pageSize: pageSizeNum,
      totalPages: Math.ceil(total / pageSizeNum),
      metrics: {
        totalAmount: totalAmountResult._sum.amount || 0,
        totalPurchases: total,
        successfulPurchases: succeededCount,
      },
    });
  } catch (error: any) {
    console.error('Error en adminListPurchases:', error);
    res.status(500).json({
      error: 'Error al obtener las compras',
      message: error.message,
    });
  }
}

/**
 * Obtiene el detalle de una compra específica
 * GET /api/admin/purchases/:id
 */
export async function adminGetPurchaseDetail(req: Request, res: Response) {
  try {
    const { id } = req.params;

    const purchase = await prisma.reservation.findUnique({
      where: { id: Number(id) },
      include: {
        buyer: {
          select: {
            id: true,
            name: true,
            email: true,
            rut: true,
          },
        },
        event: {
          include: {
            organizer: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            sections: true,
          },
        },
        payment: true,
        generatedTickets: {
          orderBy: { ticketNumber: 'asc' },
        },
        ticket: true,
        claim: {
          include: {
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

    if (!purchase) {
      return res.status(404).json({ error: 'Compra no encontrada' });
    }

    res.json(purchase);
  } catch (error: any) {
    console.error('Error en adminGetPurchaseDetail:', error);
    res.status(500).json({
      error: 'Error al obtener el detalle de la compra',
      message: error.message,
    });
  }
}
