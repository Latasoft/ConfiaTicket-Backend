// src/services/reservation.service.ts
import prisma from '../prisma/client';
import { generateQRCode, generateTicketPDF } from './ticketPdf.service';

/**
 * Procesa una reserva después del pago exitoso
 * - Para eventos OWN: genera 1 PDF por cada ticket comprado
 * - Para eventos RESALE: marca el ticket como vendido
 */
export async function processReservationAfterPayment(reservationId: number): Promise<void> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: {
      event: {
        include: {
          organizer: { select: { name: true } },
        },
      },
      buyer: { select: { name: true, email: true } },
    },
  });

  if (!reservation) {
    throw new Error('Reservation not found');
  }

  const { event, buyer } = reservation;

  // Cargar información de la sección si existe
  let sectionName: string | undefined;
  if (reservation.sectionId) {
    const section = await prisma.eventSection.findUnique({
      where: { id: reservation.sectionId },
      select: { name: true },
    });
    sectionName = section?.name;
  }

  // CASO 1: Evento OWN - Generar 1 PDF por cada ticket
  if (event.eventType === 'OWN') {
    // Parsear asientos si existen
    const seats = reservation.seatAssignment 
      ? reservation.seatAssignment.split(',').map(s => s.trim())
      : [];

    // Generar un ticket individual por cada entrada comprada
    for (let i = 0; i < reservation.quantity; i++) {
      const ticketNumber = i + 1;
      const seatNumber = seats[i] || `#${ticketNumber}`;
      
      // Generar código QR único para este ticket
      const qrCode = await generateQRCode();

      // Generar el PDF individual
      const pdfPath = await generateTicketPDF({
        eventName: event.title,
        eventDate: event.date,
        eventLocation: event.location,
        buyerName: buyer.name,
        buyerEmail: buyer.email,
        seatAssignment: seatNumber,
        sectionName,
        qrCode,
        reservationCode: reservation.code,
        ticketNumber,
        totalTickets: reservation.quantity,
        totalAmount: reservation.amount,
      });

      // Crear registro del ticket generado
      await prisma.generatedTicket.create({
        data: {
          reservationId: reservation.id,
          ticketNumber,
          seatNumber,
          qrCode,
          pdfPath,
        },
      });
    }

    // Actualizar la reserva para mantener compatibilidad (opcional)
    const allQrCodes = await prisma.generatedTicket.findMany({
      where: { reservationId: reservation.id },
      select: { qrCode: true },
    });
    
    await prisma.reservation.update({
      where: { id: reservationId },
      data: {
        qrCode: allQrCodes[0]?.qrCode, // Primer QR para compatibilidad
      },
    });
  }

  // CASO 2: Evento RESALE - Generar PDF (lógica temporal similar a OWN)
  else if (event.eventType === 'RESALE') {
    // Buscar el ticket asociado a esta reserva
    const ticket = await prisma.ticket.findFirst({
      where: { reservationId },
    });

    if (ticket) {
      // Generar código QR único
      const qrCode = await generateQRCode();

      // Información del asiento desde el ticket original
      const seatInfo = `Fila ${ticket.row}, Asiento ${ticket.seat}${ticket.zone ? ` - Zona ${ticket.zone}` : ''}`;

      // Generar el PDF individual
      const pdfPath = await generateTicketPDF({
        eventName: event.title,
        eventDate: event.date,
        eventLocation: event.location,
        buyerName: buyer.name,
        buyerEmail: buyer.email,
        seatAssignment: seatInfo,
        sectionName, // Incluir sección si existe
        qrCode,
        reservationCode: reservation.code,
        ticketNumber: 1,
        totalTickets: 1,
        totalAmount: reservation.amount,
      });

      // Crear registro del ticket generado
      await prisma.generatedTicket.create({
        data: {
          reservationId: reservation.id,
          ticketNumber: 1,
          seatNumber: seatInfo,
          qrCode,
          pdfPath,
        },
      });

      // Actualizar reserva con QR
      await prisma.reservation.update({
        where: { id: reservationId },
        data: {
          qrCode,
        },
      });

      // Marcar ticket original como vendido
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: {
          sold: true,
          soldAt: new Date(),
        },
      });
    }
  }
}

/**
 * Asigna un ticket RESALE disponible a una reserva
 * Debe llamarse ANTES del pago
 */
export async function assignResaleTicketToReservation(
  eventId: number,
  reservationId: number,
  ticketId: number
): Promise<void> {
  // Verificar que el ticket existe, no está vendido y pertenece al evento
  const ticket = await prisma.ticket.findFirst({
    where: {
      id: ticketId,
      eventId,
      sold: false,
      reservationId: null,
    },
  });

  if (!ticket) {
    throw new Error('Ticket no disponible');
  }

  // Asignar el ticket a la reserva (pero NO marcar como vendido aún)
  await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      reservationId,
    },
  });
}

/**
 * Genera asignación de asientos para eventos OWN
 * Ejemplo: "VIP: A1, A2, A3"
 */
export function generateSeatAssignment(
  sectionName: string,
  quantity: number,
  startSeat?: number
): string {
  if (!startSeat) {
    return `${sectionName}: ${quantity} asiento${quantity > 1 ? 's' : ''}`;
  }

  const seats: string[] = [];
  for (let i = 0; i < quantity; i++) {
    seats.push(`${startSeat + i}`);
  }

  return `${sectionName}: ${seats.join(', ')}`;
}
