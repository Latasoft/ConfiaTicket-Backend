// src/utils/logger.ts
/**
 * Sistema de logging crítico para monitoreo en producción
 * 
 * Niveles:
 * - CRITICAL: Errores que requieren atención inmediata (payment failures, ticket generation failures after retries)
 * - ERROR: Errores recuperables (retry attempts, validation errors)
 * - WARN: Situaciones anómalas no críticas (deprecated usage, missing optional data)
 * - INFO: Información operacional (successful payments, ticket generation success)
 * 
 * Formato: [YYYY-MM-DD HH:MM:SS][LEVEL][CONTEXT] Message
 * Ejemplo: [2025-01-15 14:23:45][CRITICAL][RES:1234] Ticket generation failed after 3 retries
 */

export enum LogLevel {
  CRITICAL = 'CRITICAL',
  ERROR = 'ERROR',
  WARN = 'WARN',
  INFO = 'INFO',
}

interface LogContext {
  reservationId?: number;
  paymentId?: number;
  userId?: number;
  eventId?: number;
  error?: Error | string;
  metadata?: Record<string, any>;
}

/**
 * Formatea timestamp en formato legible para Render console
 */
function formatTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Formatea el contexto para incluirlo en el log
 */
function formatContext(context?: LogContext): string {
  if (!context) return '';
  
  const parts: string[] = [];
  if (context.reservationId) parts.push(`RES:${context.reservationId}`);
  if (context.paymentId) parts.push(`PAY:${context.paymentId}`);
  if (context.userId) parts.push(`USER:${context.userId}`);
  if (context.eventId) parts.push(`EVENT:${context.eventId}`);
  
  return parts.length > 0 ? `[${parts.join('|')}]` : '';
}

/**
 * Logger principal - escribe a console con formato específico
 */
function log(level: LogLevel, message: string, context?: LogContext): void {
  const timestamp = formatTimestamp();
  const ctx = formatContext(context);
  const logMessage = `[${timestamp}][${level}]${ctx} ${message}`;
  
  // Nivel determina el método de console
  switch (level) {
    case LogLevel.CRITICAL:
    case LogLevel.ERROR:
      console.error(logMessage);
      if (context?.error) {
        const err = context.error instanceof Error ? context.error : new Error(String(context.error));
        console.error('Stack trace:', err.stack);
      }
      if (context?.metadata) {
        console.error('Metadata:', JSON.stringify(context.metadata, null, 2));
      }
      break;
      
    case LogLevel.WARN:
      console.warn(logMessage);
      if (context?.metadata) {
        console.warn('Metadata:', JSON.stringify(context.metadata, null, 2));
      }
      break;
      
    case LogLevel.INFO:
      console.log(logMessage);
      if (context?.metadata) {
        console.log('Metadata:', JSON.stringify(context.metadata, null, 2));
      }
      break;
  }
}

/**
 * Exportaciones de conveniencia para cada nivel
 */
export const logger = {
  critical: (message: string, context?: LogContext) => log(LogLevel.CRITICAL, message, context),
  error: (message: string, context?: LogContext) => log(LogLevel.ERROR, message, context),
  warn: (message: string, context?: LogContext) => log(LogLevel.WARN, message, context),
  info: (message: string, context?: LogContext) => log(LogLevel.INFO, message, context),
};

/**
 * Helpers específicos para casos comunes
 */
export const logPayment = {
  success: (reservationId: number, paymentId: number, amount: number) =>
    logger.info(`Payment successful - Amount: $${amount}`, { reservationId, paymentId }),
    
  failed: (reservationId: number, paymentId: number, error: Error | string) =>
    logger.critical(`Payment failed`, { reservationId, paymentId, error }),
    
  capture: (reservationId: number, paymentId: number, amount: number) =>
    logger.info(`Payment captured - Amount: $${amount}`, { reservationId, paymentId }),
};

export const logTicketGeneration = {
  start: (reservationId: number, eventType: 'OWN' | 'RESALE') =>
    logger.info(`Ticket generation started - Type: ${eventType}`, { reservationId }),
    
  retry: (reservationId: number, attempt: number, error: Error | string) =>
    logger.error(`Ticket generation retry attempt ${attempt}/3`, { reservationId, error }),
    
  success: (reservationId: number, eventType: 'OWN' | 'RESALE', count: number) =>
    logger.info(`Ticket generation successful - Type: ${eventType}, Count: ${count}`, { reservationId }),
    
  failed: (reservationId: number, error: Error | string, attempts: number) =>
    logger.critical(`Ticket generation FAILED after ${attempts} attempts`, { reservationId, error }),
};

export const logStock = {
  validationFailed: (eventId: number, requested: number, available: number, userId?: number) =>
    logger.error(`Stock validation failed - Requested: ${requested}, Available: ${available}`, {
      eventId,
      userId,
      metadata: { requested, available },
    }),
    
  ownEventSelfPurchase: (eventId: number, organizerId: number) =>
    logger.warn(`Organizer attempted to buy own event tickets`, {
      eventId,
      userId: organizerId,
    }),
};

export default logger;
