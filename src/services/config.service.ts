// src/services/config.service.ts
import prisma from '../prisma/client';

let configCache: {
  ticketLimits?: any;
  priceLimits?: any;
  fieldLimits?: any;
  businessRules?: any;
  lastFetch?: number;
} = {};

const CACHE_TTL = 5 * 60 * 1000;

async function refreshConfigCache() {
  const now = Date.now();
  
  if (configCache.lastFetch && (now - configCache.lastFetch) < CACHE_TTL) {
    return;
  }

  const [ticketLimits, priceLimit, fieldLimits, systemConfigs] = await Promise.all([
    prisma.ticketLimitConfig.findMany(),
    prisma.priceLimitConfig.findFirst(),
    prisma.fieldLimitConfig.findMany(),
    prisma.systemConfig.findMany(),
  ]);

  configCache.ticketLimits = {};
  for (const limit of ticketLimits) {
    configCache.ticketLimits[limit.eventType] = {
      MIN: limit.minCapacity,
      MAX: limit.maxCapacity,
    };
  }

  configCache.priceLimits = {
    MIN: priceLimit?.minPrice ?? 0,
    MAX: priceLimit?.maxPrice ?? 10000000,
    RESALE_MARKUP_PERCENT: priceLimit?.resaleMarkupPercent ?? 30,
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

export function clearConfigCache() {
  configCache = {};
}
