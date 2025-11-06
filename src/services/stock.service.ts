// src/services/stock.service.ts
// src/services/stock.service.ts
import prisma from '../prisma/client';
import type { Prisma } from '@prisma/client';
import { logStock } from '../utils/logger';

export type StockInfo = {
  event: {
    id: number;
    capacity: number;
    price: number | null;
    organizerId: number;
    date: Date;
    approved: boolean;
    eventType: 'OWN' | 'RESALE';
  };
  remaining: number;
  hasStarted: boolean;
};

/**
 * Calcula el stock disponible para un evento
 * - Para RESALE: cuenta tickets físicos disponibles
 * - Para OWN: usa capacidad - reservas (PAID + PENDING vigentes)
 */
export async function getRemainingStock(
  eventId: number,
  prismaClient: Prisma.TransactionClient | typeof prisma = prisma
): Promise<StockInfo> {
  const ev = await prismaClient.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      capacity: true,
      price: true,
      organizerId: true,
      date: true,
      approved: true,
      eventType: true,
    },
  });

  if (!ev) {
    const error: any = new Error('EVENT_NOT_FOUND');
    error.status = 404;
    throw error;
  }

  const now = new Date();
  const startsAt = ev.date instanceof Date ? ev.date : new Date(ev.date);
  const hasStarted = now >= startsAt;

  // ⭐ Para RESALE: stock = tickets físicos disponibles
  if (ev.eventType === 'RESALE') {
    const availableTickets = await prismaClient.ticket.count({
      where: {
        eventId,
        sold: false,
        reservationId: null,
      },
    });
    return { 
      event: ev as any, 
      remaining: availableTickets, 
      hasStarted 
    };
  }

  // Para eventos OWN: stock = capacidad - reservas activas
  const agg = await prismaClient.reservation.aggregate({
    _sum: { quantity: true },
    where: {
      eventId,
      OR: [
        { status: 'PAID' as any },
        { status: 'PENDING_PAYMENT' as any, expiresAt: { gt: now } },
      ],
    },
  });

  const used = agg._sum.quantity ?? 0;
  const remaining = Math.max(0, ev.capacity - used);

  return { 
    event: ev as any, 
    remaining, 
    hasStarted 
  };
}

/**
 * Valida que haya stock suficiente para una cantidad dada
 * Lanza error si no hay stock
 */
export async function validateStockAvailability(
  eventId: number,
  quantity: number,
  prismaClient: Prisma.TransactionClient | typeof prisma = prisma
): Promise<StockInfo> {
  const stockInfo = await getRemainingStock(eventId, prismaClient);

  if (stockInfo.remaining < quantity) {
    // LOG CRÍTICO: Error de stock
    logStock.validationFailed(eventId, quantity, stockInfo.remaining);
    throw new Error(`INSUFFICIENT_STOCK: Solo quedan ${stockInfo.remaining} disponibles`);
  }

  return stockInfo;
}

/**
 * Valida que el evento esté en estado válido para compra
 */
export async function validateEventAvailable(
  stockInfo: StockInfo
): Promise<void> {
  if (stockInfo.hasStarted) {
    const error: any = new Error('EVENT_HAS_STARTED');
    error.status = 400;
    throw error;
  }

  if (!stockInfo.event.approved) {
    const error: any = new Error('EVENT_NOT_APPROVED');
    error.status = 400;
    throw error;
  }
}

/**
 * Valida que el usuario no sea el organizador del evento
 */
export function validateNotOwnEvent(
  organizerId: number,
  buyerId: number
): void {
  if (organizerId === buyerId) {
    // LOG WARNING: Organizador intentando comprar sus propios tickets
    logStock.ownEventSelfPurchase(0, organizerId);
    const error: any = new Error('CANNOT_BUY_OWN_EVENT');
    error.status = 403;
    throw error;
  }
}
