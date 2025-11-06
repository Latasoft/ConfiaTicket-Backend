// src/utils/date.utils.ts

/**
 * Agrega minutos a una fecha
 */
export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/**
 * Agrega horas a una fecha
 */
export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + Math.max(0, hours) * 3600 * 1000);
}

/**
 * Verifica si una fecha ya expiró
 */
export function isExpired(date?: Date | null): boolean {
  if (!date) return false;
  return Date.now() > new Date(date).getTime();
}

/**
 * Retorna fecha actual
 */
export function now(): Date {
  return new Date();
}

/**
 * Crea fecha X minutos desde ahora
 */
export function minutesFromNow(minutes: number): Date {
  return addMinutes(new Date(), minutes);
}

/**
 * Crea fecha X horas desde ahora
 */
export function hoursFromNow(hours: number): Date {
  return addHours(new Date(), hours);
}
