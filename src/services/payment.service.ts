// src/services/payment.service.ts
import { env } from '../config/env';
import crypto from 'crypto';
import {
  WebpayPlus,
  Options,
  Environment,
  IntegrationCommerceCodes,
  IntegrationApiKeys,
} from 'transbank-sdk';

/* ===================== Helpers ===================== */

/**
 * Genera un buyOrder único para Transbank (máx 26 caracteres)
 */
export function generateBuyOrder(reservationId: number): string {
  const ts = Date.now().toString(36).toUpperCase();
  const s = `BO-${reservationId}-${ts}`;
  return s.slice(0, 26);
}

/**
 * Genera una clave de idempotencia única
 */
export function generateIdempotencyKey(prefix = 'payout'): string {
  try {
    return `${prefix}_${crypto.randomUUID()}`;
  } catch {
    // Fallback para Node antiguo
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

/* ===================== Transbank/Webpay ===================== */

/**
 * Obtiene el commerce code configurado según el entorno
 */
export function getCommerceCode(): string {
  const envName = (env.WEBPAY_ENV || 'INTEGRATION').toUpperCase();
  const isProd = envName === 'PRODUCTION';
  
  return isProd
    ? (env.WEBPAY_COMMERCE_CODE || '')
    : IntegrationCommerceCodes.WEBPAY_PLUS;
}

/**
 * Crea una instancia de transacción de WebpayPlus configurada según el entorno
 */
export function createWebpayTransaction() {
  const envName = (env.WEBPAY_ENV || 'INTEGRATION').toUpperCase();
  const isProd = envName === 'PRODUCTION';

  const commerceCode = isProd
    ? (env.WEBPAY_COMMERCE_CODE || '')
    : IntegrationCommerceCodes.WEBPAY_PLUS;

  const apiKey = isProd
    ? (env.WEBPAY_API_KEY || '')
    : IntegrationApiKeys.WEBPAY;

  const options = new Options(
    commerceCode,
    apiKey,
    isProd ? Environment.Production : Environment.Integration
  );

  return new WebpayPlus.Transaction(options);
}

/**
 * Crea una transacción en Webpay
 */
export async function createWebpayPayment(params: {
  buyOrder: string;
  sessionId: string;
  amount: number;
  returnUrl: string;
}): Promise<{ token: string; url: string }> {
  const tx = createWebpayTransaction();
  const response = await tx.create(
    params.buyOrder,
    params.sessionId,
    params.amount,
    params.returnUrl
  );

  return {
    token: response.token,
    url: response.url,
  };
}

/**
 * Confirma una transacción en Webpay
 */
export async function commitWebpayPayment(token: string): Promise<any> {
  const tx = createWebpayTransaction();
  return await tx.commit(token);
}

/**
 * Obtiene el estado de una transacción en Webpay
 */
export async function getWebpayStatus(token: string): Promise<any> {
  const tx = createWebpayTransaction();
  return await tx.status(token);
}

/**
 * Captura una pre-autorización en Webpay
 */
export async function captureWebpayPayment(params: {
  token: string;
  buyOrder: string;
  authorizationCode: string;
  amount: number;
}): Promise<any> {
  const tx = createWebpayTransaction();
  return await tx.capture(
    params.token,
    params.buyOrder,
    params.authorizationCode,
    params.amount
  );
}

/**
 * Realiza un reembolso en Webpay
 */
export async function refundWebpayPayment(params: {
  token: string;
  amount: number;
}): Promise<any> {
  const tx = createWebpayTransaction();
  return await tx.refund(params.token, params.amount);
}

/* ===================== Cálculos de negocio ===================== */

/**
 * Calcula el monto de la comisión de plataforma
 */
export function calculatePlatformFee(amount: number, feeBps: number): number {
  return Math.round((amount * feeBps) / 10000);
}

/**
 * Calcula el monto neto para el organizador
 */
export function calculateOrganizerAmount(totalAmount: number, platformFee: number): number {
  return totalAmount - platformFee;
}

/**
 * Valida el estado de un pago de Webpay
 */
export function isPaymentSuccessful(responseCode: number | string): boolean {
  return String(responseCode) === '0';
}

/**
 * Obtiene el mensaje de error según el código de respuesta de Webpay
 */
export function getWebpayErrorMessage(responseCode: number | string): string {
  const code = String(responseCode);
  const errors: Record<string, string> = {
    '-1': 'Rechazo de transacción - Reintente en unos minutos',
    '-2': 'Transacción debe reintentarse',
    '-3': 'Error en transacción',
    '-4': 'Rechazo de transacción - Reintente en unos minutos',
    '-5': 'Rechazo por error de tasa',
    '-6': 'Excede cupo máximo mensual',
    '-7': 'Excede límite diario por transacción',
    '-8': 'Rubro no autorizado',
  };

  return errors[code] || 'Error en la transacción';
}
