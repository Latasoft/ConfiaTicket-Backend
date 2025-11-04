// src/utils/config-loader.ts
import {
  getTicketLimits,
  getPriceLimits,
  getFieldLimits,
  getAllowedAccountTypes,
} from '../services/config.service';

export async function loadAllLimits() {
  const [ticketLimits, priceLimits, fieldLimits, allowedAccountTypes] = await Promise.all([
    getTicketLimits(),
    getPriceLimits(),
    getFieldLimits(),
    getAllowedAccountTypes(),
  ]);

  return {
    TICKET_LIMITS: ticketLimits,
    PRICE_LIMITS: priceLimits,
    FIELD_LIMITS: fieldLimits,
    ALLOWED_ACCOUNT_TYPES: allowedAccountTypes,
  };
}
