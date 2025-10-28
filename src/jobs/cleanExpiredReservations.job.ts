// src/jobs/cleanExpiredReservations.job.ts
import prisma from '../prisma/client';

/**
 * Job para limpiar reservas expiradas
 * Marca como EXPIRED las reservas PENDING_PAYMENT cuyo expiresAt ya pasó
 * Esto libera el stock para que otros puedan comprar
 */
export async function cleanExpiredReservations(): Promise<number> {
  try {
    const now = new Date();
    
    // Buscar las reservas expiradas
    const expiredReservations = await prisma.reservation.findMany({
      where: {
        status: 'PENDING_PAYMENT',
        expiresAt: {
          lte: now
        }
      },
      select: {
        id: true,
      }
    });

    if (expiredReservations.length === 0) {
      return 0;
    }

    const expiredIds = expiredReservations.map(r => r.id);

    // Liberar tickets RESALE asociados a estas reservas
    await prisma.ticket.updateMany({
      where: {
        reservationId: { in: expiredIds }
      },
      data: {
        reservationId: null
      }
    });

    // Marcar las reservas como expiradas
    const result = await prisma.reservation.updateMany({
      where: {
        id: { in: expiredIds }
      },
      data: {
        status: 'EXPIRED'
      }
    });

    if (result.count > 0) {
      console.log(`[CleanExpiredReservations] Marcadas ${result.count} reservas como EXPIRED y liberados sus tickets`);
    }

    return result.count;
  } catch (error) {
    console.error('[CleanExpiredReservations] Error:', error);
    throw error;
  }
}

/**
 * Ejecutar el job cada X minutos
 * Se puede configurar con cron o setInterval
 */
export function startCleanExpiredReservationsJob(intervalMinutes: number = 5) {
  console.log(`[CleanExpiredReservations] Job iniciado - se ejecutará cada ${intervalMinutes} minutos`);
  
  // Ejecutar inmediatamente
  cleanExpiredReservations();
  
  // Luego ejecutar periódicamente
  setInterval(async () => {
    try {
      await cleanExpiredReservations();
    } catch (error) {
      console.error('[CleanExpiredReservations] Error en ejecución periódica:', error);
    }
  }, intervalMinutes * 60 * 1000);
}
