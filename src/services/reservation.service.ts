// src/services/reservation.service.ts
/**
 * ⚠️ ESTE SERVICIO ESTÁ DEPRECADO
 * 
 * La generación de tickets ahora se maneja en:
 * - ticketGeneration.service.ts (generación con retry)
 * 
 * Este archivo se mantiene solo para funciones de email que aún se usan.
 * TODO: Migrar emails a email.service.ts y eliminar este archivo
 */
import prisma from '../prisma/client';
import { 
  sendPurchaseConfirmationEmail, 
  sendPurchaseNotificationToAdmin 
} from './email.service';

/**
 * @deprecated Usar ticketGeneration.service.ts en su lugar
 * Mantenido solo para compatibilidad temporal
 */
export async function processReservationAfterPayment(reservationId: number): Promise<void> {
  console.warn('⚠️ processReservationAfterPayment está deprecado. Usar queueTicketGeneration() en su lugar');
  
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: {
      event: true,
      buyer: { select: { name: true, email: true } },
    },
  });

  if (!reservation || !reservation.event || !reservation.buyer) {
    throw new Error('Reservation, event or buyer not found');
  }

  const { event, buyer } = reservation;

  // Solo enviar emails (la generación de PDFs se hace en ticketGeneration.service.ts)
  await sendPurchaseConfirmationEmail({
    buyerEmail: buyer.email,
    buyerName: buyer.name,
    eventTitle: event.title,
    eventDate: event.date,
    eventLocation: event.location,
    quantity: reservation.quantity,
    totalAmount: reservation.amount,
    reservationCode: reservation.code,
    reservationId: reservation.id,
  });

  await sendPurchaseNotificationToAdmin({
    buyerName: buyer.name,
    buyerEmail: buyer.email,
    eventTitle: event.title,
    quantity: reservation.quantity,
    totalAmount: reservation.amount,
    reservationId: reservation.id,
  });
}
