// src/services/ticketGeneration.service.ts
import prisma from '../prisma/client';
import { generateQRCode, generateTicketPDF } from './ticketPdf.service';
import { generateResaleTicketPDF } from './resaleTicketPdf.service';
import { 
  sendPurchaseConfirmationEmail, 
  sendPurchaseNotificationToAdmin 
} from './email.service';
import { logTicketGeneration } from '../utils/logger';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000; // 2 segundos entre reintentos

/**
 * Estado de generación de tickets
 */
type GenerationStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

/**
 * Resultado de generación
 */
export type GenerationResult = {
  success: boolean;
  ticketsGenerated: number;
  error?: string;
};

/**
 * Espera asíncrona
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Genera tickets para un evento OWN con retry logic
 */
async function generateOwnEventTickets(reservationId: number): Promise<GenerationResult> {
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

  if (!reservation || !reservation.event || !reservation.buyer) {
    throw new Error('Reservation, event or buyer not found');
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

  // Parsear asientos si existen
  const seats = reservation.seatAssignment 
    ? reservation.seatAssignment.split(',').map(s => s.trim())
    : [];

  // Generar todos los PDFs en paralelo (con límite de concurrencia implícito)
  const ticketsData = await Promise.all(
    Array.from({ length: reservation.quantity }, async (_, i) => {
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

      return {
        ticketNumber,
        seatNumber,
        qrCode,
        pdfPath,
      };
    })
  );

  // Insertar TODOS los tickets en una sola operación (bulk insert)
  await prisma.generatedTicket.createMany({
    data: ticketsData.map(t => ({
      reservationId: reservation.id,
      ticketNumber: t.ticketNumber,
      seatNumber: t.seatNumber,
      qrCode: t.qrCode,
      pdfPath: t.pdfPath,
    })),
  });

  // Actualizar la reserva con el QR del primer ticket (compatibilidad)
  await prisma.reservation.update({
    where: { id: reservationId },
    data: {
      qrCode: ticketsData[0]?.qrCode,
    },
  });

  return {
    success: true,
    ticketsGenerated: ticketsData.length,
  };
}

/**
 * Genera ticket para un evento RESALE con retry logic
 */
async function generateResaleEventTicket(reservationId: number): Promise<GenerationResult> {
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

  // Buscar el ticket asociado a esta reserva
  const ticket = await prisma.ticket.findFirst({
    where: { reservationId },
  });

  if (!ticket) {
    throw new Error('Ticket RESALE not found for reservation');
  }

  if (!ticket.proxyQrCode) {
    throw new Error('Ticket RESALE does not have proxy QR code');
  }

  // Generar el PDF con el QR proxy (NO el QR original)
  const pdfPath = await generateResaleTicketPDF({
    eventName: event.title,
    eventDate: event.date,
    eventLocation: event.location,
    eventCity: event.city,
    eventCommune: event.commune,
    buyerName: buyer.name,
    buyerEmail: buyer.email,
    ticketCode: ticket.ticketCode,
    row: ticket.row,
    seat: ticket.seat,
    zone: ticket.zone,
    level: ticket.level,
    proxyQrCode: ticket.proxyQrCode,
    reservationCode: reservation.code,
    totalAmount: reservation.amount,
    priceBase: event.priceBase,
  });

  // Crear registro del ticket generado con el QR proxy
  const seatInfo = `${ticket.row}${ticket.seat}${ticket.zone ? ` - ${ticket.zone}` : ''}`;
  
  await prisma.generatedTicket.create({
    data: {
      reservationId: reservation.id,
      ticketNumber: 1,
      seatNumber: seatInfo,
      qrCode: ticket.proxyQrCode,
      pdfPath,
    },
  });

  // Actualizar reserva con el QR proxy
  await prisma.reservation.update({
    where: { id: reservationId },
    data: {
      qrCode: ticket.proxyQrCode,
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

  return {
    success: true,
    ticketsGenerated: 1,
  };
}

/**
 * Genera tickets para una reserva con lógica de retry
 * Esta función maneja tanto eventos OWN como RESALE
 */
export async function generateTicketsWithRetry(
  reservationId: number,
  retryCount = 0
): Promise<GenerationResult> {
  try {
    // Obtener tipo de evento
    const reservation = await prisma.reservation.findUnique({
      where: { id: reservationId },
      include: { event: { select: { eventType: true } } },
    });

    if (!reservation) {
      throw new Error('Reservation not found');
    }

    const eventType = reservation.event.eventType;
    
    // Log inicio (solo en primer intento)
    if (retryCount === 0) {
      logTicketGeneration.start(reservationId, eventType);
    }

    // Generar según tipo de evento
    const result = eventType === 'OWN'
      ? await generateOwnEventTickets(reservationId)
      : await generateResaleEventTicket(reservationId);

    // Log éxito
    logTicketGeneration.success(reservationId, eventType, result.ticketsGenerated);
    
    return result;

  } catch (error: any) {
    // Retry logic
    if (retryCount < MAX_RETRIES - 1) {
      logTicketGeneration.retry(reservationId, retryCount + 1, error);
      await delay(RETRY_DELAY_MS);
      return generateTicketsWithRetry(reservationId, retryCount + 1);
    }

    // Máximo de reintentos alcanzado - LOG CRÍTICO
    logTicketGeneration.failed(reservationId, error, MAX_RETRIES);
    
    return {
      success: false,
      ticketsGenerated: 0,
      error: error.message || 'Unknown error',
    };
  }
}

/**
 * Procesa generación de tickets de forma asíncrona
 * Maneja envío de emails y actualización de estado
 */
export async function queueTicketGeneration(reservationId: number): Promise<void> {
  // Fire-and-forget con manejo robusto de errores
  generateTicketsWithRetry(reservationId)
    .then(async (result) => {
      if (result.success) {
        console.log(`✅ [TICKET_QUEUE] Tickets generados para reserva ${reservationId}`);
        
        // Enviar emails de confirmación (solo una vez por grupo de compra)
        try {
          const reservation = await prisma.reservation.findUnique({
            where: { id: reservationId },
            include: {
              event: true,
              buyer: { select: { name: true, email: true } },
            },
          });

          if (reservation && reservation.event && reservation.buyer) {
            const { event, buyer } = reservation;

            // Verificar si esta reserva tiene purchaseGroupId (compra múltiple)
            if (reservation.purchaseGroupId) {
              // Verificar si ya enviamos email para este grupo
              const allGroupReservations = await prisma.reservation.findMany({
                where: { purchaseGroupId: reservation.purchaseGroupId },
                orderBy: { id: 'asc' },
                select: { id: true, quantity: true, amount: true },
              });

              // Solo enviar email si esta es la PRIMERA reserva del grupo
              const isFirstReservation = allGroupReservations[0]?.id === reservationId;
              
              if (isFirstReservation) {
                // Calcular totales del grupo completo
                const totalQuantity = allGroupReservations.reduce((sum, r) => sum + r.quantity, 0);
                const totalAmount = allGroupReservations.reduce((sum, r) => sum + r.amount, 0);

                console.log(`📧 [TICKET_QUEUE] Enviando email grupal para purchaseGroup ${reservation.purchaseGroupId}`);
                console.log(`   Total reservas: ${allGroupReservations.length}, Cantidad: ${totalQuantity}, Monto: ${totalAmount}`);

                // Email de confirmación al comprador con totales del grupo
                await sendPurchaseConfirmationEmail({
                  buyerEmail: buyer.email,
                  buyerName: buyer.name,
                  eventTitle: event.title,
                  eventDate: event.date,
                  eventLocation: event.location,
                  quantity: totalQuantity,
                  totalAmount: totalAmount,
                  reservationCode: reservation.code,
                  reservationId: reservation.id,
                });

                // Notificación al admin con totales del grupo
                await sendPurchaseNotificationToAdmin({
                  buyerName: buyer.name,
                  buyerEmail: buyer.email,
                  eventTitle: event.title,
                  quantity: totalQuantity,
                  totalAmount: totalAmount,
                  reservationId: reservation.id,
                });

                console.log(`✉️ [TICKET_QUEUE] Email grupal enviado para grupo ${reservation.purchaseGroupId}`);
              } else {
                console.log(`⏭️ [TICKET_QUEUE] Email ya enviado para grupo ${reservation.purchaseGroupId}, saltando reserva ${reservationId}`);
              }
            } else {
              // Compra simple sin grupo - enviar email normalmente
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

              // Notificación al admin
              await sendPurchaseNotificationToAdmin({
                buyerName: buyer.name,
                buyerEmail: buyer.email,
                eventTitle: event.title,
                quantity: reservation.quantity,
                totalAmount: reservation.amount,
                reservationId: reservation.id,
              });

              console.log(`✉️ [TICKET_QUEUE] Email individual enviado para reserva ${reservationId}`);
            }
          }
        } catch (emailError: any) {
          console.error(`❌ [TICKET_QUEUE] Error enviando emails para reserva ${reservationId}:`, emailError.message);
          // Los emails fallan silenciosamente, no afectan la generación
        }
      } else {
        console.error(`❌ [TICKET_QUEUE] Fallo en generación de reserva ${reservationId}:`, result.error);
        // TODO: Aquí podrías crear un registro en BD para revisión manual
        // o enviar notificación al admin de que requiere atención
      }
    })
    .catch((error) => {
      console.error(`💥 [TICKET_QUEUE] Error crítico en reserva ${reservationId}:`, error);
    });
}
