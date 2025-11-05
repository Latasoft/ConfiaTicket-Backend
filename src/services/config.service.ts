// src/services/config.service.ts
import prisma from '../prisma/client';
import { env } from '../config/env';

let configCache: {
  ticketLimits?: any;
  priceLimits?: any;
  platformFee?: any;
  fieldLimits?: any;
  businessRules?: any;
  reservationHold?: any;
  lastFetch?: number;
} = {};

const CACHE_TTL = 5 * 60 * 1000;

async function refreshConfigCache() {
  const now = Date.now();
  
  if (configCache.lastFetch && (now - configCache.lastFetch) < CACHE_TTL) {
    return;
  }

  const [ticketLimits, priceLimit, platformFee, fieldLimits, systemConfigs, reservationHold] = await Promise.all([
    prisma.ticketLimitConfig.findMany(),
    prisma.priceLimitConfig.findFirst(),
    prisma.platformFeeConfig.findFirst(),
    prisma.fieldLimitConfig.findMany(),
    prisma.systemConfig.findMany(),
    prisma.reservationHoldConfig.findFirst(),
  ]);

  configCache.ticketLimits = {};
  for (const limit of ticketLimits) {
    configCache.ticketLimits[limit.eventType] = {
      MIN: limit.minCapacity,
      MAX: limit.maxCapacity, // Puede ser null para indicar sin límite
    };
  }

  configCache.priceLimits = {
    MIN: priceLimit?.minPrice ?? 0,
    MAX: priceLimit?.maxPrice ?? 10000000,
    RESALE_MARKUP_PERCENT: priceLimit?.resaleMarkupPercent ?? 30,
  };

  configCache.platformFee = {
    feeBps: platformFee?.feeBps ?? 0,
    feePercent: ((platformFee?.feeBps ?? 0) / 100).toFixed(2),
  };

  configCache.fieldLimits = {};
  for (const field of fieldLimits) {
    configCache.fieldLimits[field.fieldName] = field.maxLength;
  }

  configCache.businessRules = {};
  for (const config of systemConfigs) {
    let value: any = config.value;
    
    if (config.dataType === 'INTEGER') {
      value = parseInt(config.value, 10);
    } else if (config.dataType === 'DECIMAL') {
      value = parseFloat(config.value);
    } else if (config.dataType === 'BOOLEAN') {
      value = config.value === 'true';
    }
    
    configCache.businessRules[config.key] = value;
  }

  // Configuración de hold de reservas con prioridad: DB > ENV > Default (15)
  configCache.reservationHold = {
    holdMinutes: reservationHold?.holdMinutes ?? env.RESERVATION_HOLD_MINUTES ?? 15,
  };

  configCache.lastFetch = now;
}

export async function getTicketLimits() {
  await refreshConfigCache();
  return configCache.ticketLimits!;
}

export async function getPriceLimits() {
  await refreshConfigCache();
  return configCache.priceLimits!;
}

export async function getPlatformFee() {
  await refreshConfigCache();
  return configCache.platformFee!;
}

export async function getPlatformFeeBps(): Promise<number> {
  await refreshConfigCache();
  return configCache.platformFee?.feeBps ?? 0;
}

export async function getFieldLimits() {
  await refreshConfigCache();
  return configCache.fieldLimits!;
}

export async function getBusinessRules() {
  await refreshConfigCache();
  return configCache.businessRules!;
}

export async function getAllConfig() {
  await refreshConfigCache();
  return {
    ticketLimits: configCache.ticketLimits,
    priceLimits: configCache.priceLimits,
    platformFee: configCache.platformFee,
    fieldLimits: configCache.fieldLimits,
    businessRules: configCache.businessRules,
  };
}

export function calculateMaxResalePrice(basePrice: number): number {
  const markup = configCache.priceLimits?.RESALE_MARKUP_PERCENT ?? 30;
  return Math.floor(basePrice * (1 + markup / 100));
}

export async function getAllowedAccountTypes(): Promise<string[]> {
  const rules = await getBusinessRules();
  const value = rules['ALLOWED_ACCOUNT_TYPES'] || 'corriente,vista,ahorro,rut';
  return value.split(',').map((s: string) => s.trim());
}

/**
 * Obtiene el tiempo de hold de reservas en minutos
 * Prioridad: DB > ENV > Default (15)
 */
export async function getReservationHoldMinutes(): Promise<number> {
  await refreshConfigCache();
  return configCache.reservationHold?.holdMinutes ?? 15;
}

export function clearConfigCache() {
  configCache = {};
}
