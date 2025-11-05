// src/controllers/payments.controller.ts
import { Request, Response } from 'express';
import prisma from '../prisma/client';
import { env } from '../config/env';
import fs from 'fs';
import path from 'path';
// ⬇️ Provider de payouts (http/sim)
import { getPayoutProvider } from '../services/payouts/provider';
import { processReservationAfterPayment } from '../services/reservation.service';
import { getPlatformFeeBps, getReservationHoldMinutes, getMaxTicketsPerPurchase } from '../services/config.service';
import crypto from 'crypto';

// Transbank SDK (Node)
import {
  WebpayPlus,
  Options,
  Environment,
  IntegrationCommerceCodes,
  IntegrationApiKeys,
} from 'transbank-sdk';

/* ===================== Helpers generales ===================== */

function toInt(v: unknown, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : def;
}
function now() {
  return new Date();
}
function minutesFromNow(min: number) {
  return new Date(Date.now() + min * 60 * 1000);
}
function hoursFrom(date: Date, hours: number) {
  return new Date(date.getTime() + Math.max(0, hours) * 3600 * 1000);
}
function newIdempotencyKey(prefix = 'payout') {
  try {
    return `${prefix}_${crypto.randomUUID()}`;
  } catch {
    // Fallback para Node viejo
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

// DEPRECADO: Usar getMaxTicketsPerPurchase() en su lugar
const MAX_PER_PURCHASE = 4;
const HOLD_MINUTES = 15;

// ⏱️ Plazo para que el organizador suba el archivo (por defecto 24h)
const UPLOAD_DEADLINE_HOURS = (() => {
  const n = Number(env.TICKET_UPLOAD_DEADLINE_HOURS ?? 24);
  return Number.isFinite(n) && n > 0 ? n : 24;
})();

// ⏱️ Retención bancaria de la pre-autorización
const AUTH_HOLD_HOURS = (() => {
  const n = Number(env.AUTH_HOLD_HOURS ?? 72);
  return Number.isFinite(n) && n > 0 ? n : 72;
})();

/** Configura una transacción de WebpayPlus con opciones según .env */
function tbkTx() {
  const envName = (env.WEBPAY_ENV || 'INTEGRATION').toUpperCase();
  const isProd = envName === 'PRODUCTION';

  // Webpay Plus Normal
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

/** Genera un buyOrder corto y único (TBK suele aceptar ~26–40 chars) */
function makeBuyOrder(reservationId: number) {
  const ts = Date.now().toString(36).toUpperCase();
  const s = `BO-${reservationId}-${ts}`;
  return s.slice(0, 26);
}

/** Verifica por token (rápido) si el usuario es organizador aprobado */
function isOrganizerApproved(_req: Request) {
  // Mantengo la firma por compatibilidad; se usa la versión por DB más abajo
  return true;
}

/** ✅ Verifica en BD si el usuario es organizador (puedes afinar según tu schema de aprobación) */
async function isOrganizerApprovedByDb(req: Request) {
  const userId = (req as any)?.user?.id as number | undefined;
  if (!userId) return false;

  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  return !!u && u.role === 'organizer';
}

/* ===================== Controladores ===================== */

/**
 * POST /api/payments/create
 * Body: { eventId: number, quantity: number }
 * Requiere usuario autenticado (usa req.user?.id)
 * - Si ya existe una reserva PENDING_PAYMENT vigente del usuario para ese evento,
 *   la reutiliza y refresca el hold.
 * - Reusa/actualiza el Payment de esa reserva (un único payment por reservationId).
 */
export async function createPayment(req: Request, res: Response) {
  try {
    const userId = (req as any)?.user?.id as number | undefined;
    if (!userId) return res.status(401).json({ error: 'No autenticado' });

    const reservationId = toInt(req.body?.reservationId);
    
    if (!reservationId) {
      return res.status(400).json({ error: 'reservationId requerido' });
    }
    
    if (!env.WEBPAY_RETURN_URL) {
      return res.status(500).json({ error: 'Falta configurar WEBPAY_RETURN_URL en .env' });
    }

    const isProd = (env.WEBPAY_ENV || 'INTEGRATION').toUpperCase() === 'PRODUCTION';
    const commerceCodeForEnv = isProd
      ? (env.WEBPAY_COMMERCE_CODE || '')
      : IntegrationCommerceCodes.WEBPAY_PLUS_DEFERRED;

    const { reservation, payment, event } = await prisma.$transaction(async (tx) => {
      // Obtener reserva existente de holdReservation
      const reservationData = await tx.reservation.findUnique({
        where: { id: reservationId },
        include: { event: true },
      });

      if (!reservationData) throw new Error('Reserva no encontrada');
      if (reservationData.buyerId !== userId) {
        const e: any = new Error('No autorizado');
        e.status = 403;
        throw e;
      }
      if (reservationData.status === 'PAID') {
        throw new Error('La reserva ya fue pagada');
      }
      if (reservationData.status === 'CANCELED' || reservationData.status === 'EXPIRED') {
        throw new Error('La reserva ya expiró o fue cancelada');
      }
      if (reservationData.expiresAt && new Date(reservationData.expiresAt) <= now()) {
        throw new Error('La reserva expiró');
      }

      const event = reservationData.event;

      // Renovar expiración para dar tiempo al pago
      await tx.reservation.update({
        where: { id: reservationData.id },
        data: { expiresAt: minutesFromNow(HOLD_MINUTES) },
      });

      // Usar la reserva original con event incluido
      const reservation = { ...reservationData, expiresAt: minutesFromNow(HOLD_MINUTES) };

      // Reusar/actualizar el Payment por reservationId (único)
      let payment = await tx.payment.findUnique({
        where: { reservationId: reservation.id },
      });

      const buyOrder = makeBuyOrder(reservation.id);
      const sessionId = `u${userId}-r${reservation.id}-${Date.now().toString(36)}`;
      const amount = reservation.amount;

      if (payment) {
        if (payment.status === 'CAPTURED' || payment.status === 'COMMITTED') {
          throw new Error('La reserva ya fue pagada');
        }
        payment = await tx.payment.update({
          where: { id: payment.id },
          data: {
            amount,
            status: 'INITIATED',
            buyOrder,
            sessionId,
            token: null,
            authorizationCode: null,
            paymentTypeCode: null,
            installmentsNumber: null,
            responseCode: null,
            accountingDate: null,
            transactionDate: null,
            cardLast4: null,
            vci: null,
            environment: env.WEBPAY_ENV || 'INTEGRATION',
            commerceCode: commerceCodeForEnv,
            isDeferredCapture: true,
          },
        });
      } else {
        payment = await tx.payment.create({
          data: {
            reservationId: reservation.id,
            amount,
            status: 'INITIATED',
            buyOrder,
            sessionId,
            environment: env.WEBPAY_ENV || 'INTEGRATION',
            commerceCode: commerceCodeForEnv,
            isDeferredCapture: false, // Captura inmediata
          },
        });
      }

      return { reservation, payment, event };
    });

    // Crear transacción en Webpay
    const tx = tbkTx();
    const createResp = await tx.create(
      payment.buyOrder!,
      payment.sessionId!,
      payment.amount,
      env.WEBPAY_RETURN_URL!
    );

    // Guarda el token
    await prisma.payment.update({
      where: { id: payment.id },
      data: { token: createResp.token },
    });

    // Entrega al front la url y el token para redirigir
    return res.status(200).json({
      url: createResp.url,
      token: createResp.token,
      reservationId: reservation.id,
      eventId: event.id,
      amount: payment.amount,
      holdExpiresAt: reservation.expiresAt,
    });
  } catch (err: any) {
    console.error('createPayment error:', err);
    const status = Number.isInteger(err?.status) ? err.status : (err?.message === 'CANNOT_BUY_OWN_EVENT' ? 403 : 400);
    const message = err?.message || 'Error creando el pago';
    return res.status(status).json({ error: message });
  }
}

/**
 * POST/GET /api/payments/commit
 * Webpay envía:
 *  - éxito: token_ws
 *  - abortado: TBK_TOKEN (+ TBK_ORDEN_COMPRA, TBK_ID_SESION)
 *
 * En captura diferida:
 *  - Si OK → guardamos AUTHORIZED + authorizationCode + authorizationExpiresAt.
 *  - NO marcamos la reserva como PAID (se capturará tras aprobar ticket).
 *  - NUEVO: si el organizador tiene ConnectedAccount, guardamos destinationAccountId en Payment.
 */
export async function commitPayment(req: Request, res: Response) {
  console.log('🔵 [COMMIT] Iniciando commitPayment');
  console.log('🔵 [COMMIT] Method:', req.method);
  console.log('🔵 [COMMIT] Headers:', JSON.stringify(req.headers, null, 2));
  console.log('🔵 [COMMIT] Body:', JSON.stringify(req.body, null, 2));
  console.log('🔵 [COMMIT] Query:', JSON.stringify(req.query, null, 2));
  
  try {
    const token = String(
      (req.body?.token_ws ?? req.query?.token_ws ?? '')
    ).trim();

    // Caso abortado por el usuario
    const tbkToken = String(
      (req.body?.TBK_TOKEN ?? req.query?.TBK_TOKEN ?? '')
    ).trim();

    if (!token && tbkToken) {
      const tbkOrder = String(
        (req.body?.TBK_ORDEN_COMPRA ?? req.query?.TBK_ORDEN_COMPRA ?? '')
      ).trim();

      // Marca como ABORTED si hay match local
      if (tbkOrder) {
        await prisma.payment.updateMany({
          where: { buyOrder: tbkOrder },
          data: { status: 'ABORTED' },
        });
      }

      if (env.WEBPAY_FINAL_URL) {
        const u = new URL(env.WEBPAY_FINAL_URL);
        u.searchParams.set('status', 'aborted');
        if (tbkOrder) u.searchParams.set('buyOrder', tbkOrder);
        return res.redirect(303, u.toString());
      }
      return res.status(200).json({ ok: false, aborted: true, buyOrder: tbkOrder || null });
    }

    if (!token) return res.status(400).json({ error: 'token_ws faltante' });

    console.log('🔵 [COMMIT] Token recibido:', token);

    // Ejecuta commit en Webpay
    const tx = tbkTx();
    console.log('🔵 [COMMIT] Llamando a Transbank commit...');
    const commit = await tx.commit(token);
    console.log('🔵 [COMMIT] Respuesta de Transbank:', JSON.stringify(commit, null, 2));

    const payment = await prisma.payment.findUnique({
      where: { token },
      include: {
        reservation: {
          include: {
            event: { select: { organizerId: true } },
            buyer: { select: { id: true } },
          }
        },
      },
    });
    
    console.log('🔵 [COMMIT] Payment encontrado:', payment ? `ID: ${payment.id}, Status: ${payment.status}` : 'NO ENCONTRADO');
    
    if (!payment) {
      console.error('❌ [COMMIT] ERROR: Transacción no encontrada para token:', token);
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    const isApproved = !!commit && commit.response_code === 0;
    const isOwnEvent =
      !!payment.reservation &&
      payment.reservation.event?.organizerId === payment.reservation.buyerId;

    console.log('🔵 [COMMIT] isApproved:', isApproved, 'isOwnEvent:', isOwnEvent);
    console.log('🔵 [COMMIT] response_code:', commit.response_code);

    // Detectar cuenta conectada del organizador para enrutar payout
    let destAccountId: number | null = null;
    if (isApproved && !isOwnEvent && payment.reservation?.event?.organizerId) {
      const acct = await prisma.connectedAccount.findUnique({
        where: { userId: payment.reservation.event.organizerId },
      });
      if (acct && acct.payoutsEnabled) destAccountId = acct.id;
    }
    const finalDestAccountId = payment.destinationAccountId ?? destAccountId ?? null;

    // Calcular comisión de plataforma para el payout
    const platformFeeBps = await getPlatformFeeBps();
    const subtotal = payment.amount;
    const applicationFeeAmount = Math.round(subtotal * platformFeeBps / 10000);
    const netAmount = Math.max(0, subtotal - applicationFeeAmount);

    await prisma.$transaction(async (txp) => {
      // Actualizar Payment con información de Transbank
      await txp.payment.update({
        where: { id: payment.id },
        data: {
          // Captura inmediata: COMMITTED (no AUTHORIZED)
          status: isApproved && !isOwnEvent ? 'COMMITTED' : 'FAILED',
          authorizationCode: (commit as any)?.authorization_code || null,
          paymentTypeCode: (commit as any)?.payment_type_code || null,
          installmentsNumber: (commit as any)?.installments_number ?? null,
          responseCode: (commit as any)?.response_code ?? null,
          accountingDate: (commit as any)?.accounting_date || null,
          transactionDate: (commit as any)?.transaction_date || null,
          cardLast4: (commit as any)?.card_detail?.card_number
            ? String((commit as any).card_detail.card_number).slice(-4)
            : null,
          vci: (commit as any)?.vci || null,
          destinationAccountId: finalDestAccountId,
          applicationFeeAmount,
          netAmount,
        },
      });

      // Marcar Reservation como PAID inmediatamente
      if (payment.reservationId) {
        await txp.reservation.update({
          where: { id: payment.reservationId },
          data: isApproved && !isOwnEvent
            ? {
                status: 'PAID',
                paidAt: now(),
                fulfillmentStatus: 'TICKET_APPROVED',
                approvedAt: now(),
              }
            : { status: 'CANCELED' },
        });
      }

      // Crear Payout PENDING si hay cuenta conectada
      if (isApproved && !isOwnEvent && finalDestAccountId && payment.reservationId) {
        await txp.payout.create({
          data: {
            accountId: finalDestAccountId,
            reservationId: payment.reservationId,
            paymentId: payment.id,
            amount: netAmount,
            status: 'PENDING',
            currency: 'CLP',
            idempotencyKey: newIdempotencyKey(),
          },
        });
      }
    });

    // Procesar reserva: generar PDFs (OWN) o marcar vendido (RESALE)
    if (isApproved && !isOwnEvent && payment.reservationId) {
      console.log('🔵 [COMMIT] Procesando reserva:', payment.reservationId);
      try {
        await processReservationAfterPayment(payment.reservationId);
        console.log('✅ [COMMIT] Reserva procesada exitosamente');
      } catch (pdfError) {
        console.error('❌ [COMMIT] Error procesando reserva:', pdfError);
        // No fallar la respuesta, el pago ya se confirmó
      }
    }

    const payload: any = {
      ok: isApproved && !isOwnEvent,
      token,
      buyOrder: payment.buyOrder,
      amount: payment.amount,
      authorizationCode: (commit as any)?.authorization_code,
      responseCode: (commit as any)?.response_code,
      reservationId: payment.reservationId,
      note: isApproved && !isOwnEvent 
        ? 'Pago confirmado. Tu entrada está lista para descargar.' 
        : 'Pago procesado.',
    };

    console.log('🔵 [COMMIT] Payload creado:', payload);
    console.log('🔵 [COMMIT] WEBPAY_FINAL_URL:', env.WEBPAY_FINAL_URL);

    if (env.WEBPAY_FINAL_URL) {
      // Redirigir a la vista del evento con modal de éxito
      const eventId = payment.reservation?.eventId;
      console.log('🔵 [COMMIT] EventID para redirección:', eventId);
      if (eventId && payload.ok) {
        console.log('🔵 [COMMIT] Construyendo URL de redirección exitosa...');
        // Construir URL: /eventos/:id?showPurchaseSuccess=true&reservationId=X
        // Normalizar base URL (remover /eventos o /payment-result si existen)
        let baseUrl = env.WEBPAY_FINAL_URL.replace(/\/payment-result\/?$/, '').replace(/\/eventos\/?$/, '');
        const eventUrl = `${baseUrl}/eventos/${eventId}`;
        const u = new URL(eventUrl);
        u.searchParams.set('showPurchaseSuccess', 'true');
        u.searchParams.set('reservationId', String(payment.reservationId));
        if (payment.reservation?.purchaseGroupId) {
          u.searchParams.set('purchaseGroupId', payment.reservation.purchaseGroupId);
        }
        console.log('✅ [COMMIT] Redirigiendo a:', u.toString());
        return res.redirect(303, u.toString());
      }
      
      console.log('⚠️ [COMMIT] Usando fallback de redirección...');
      // Fallback: ruta legacy payment-result (solo para errores)
      let baseUrl = env.WEBPAY_FINAL_URL.replace(/\/payment-result\/?$/, '').replace(/\/eventos\/?$/, '');
      const u = new URL(`${baseUrl}/payment-result`);
      u.searchParams.set('status', payload.ok ? 'success' : (isOwnEvent ? 'own-event-forbidden' : 'failed'));
      u.searchParams.set('token', token);
      u.searchParams.set('buyOrder', payment.buyOrder || '');
      u.searchParams.set('amount', String(payment.amount));
      if (payment.reservationId) u.searchParams.set('reservationId', String(payment.reservationId));
      console.log('⚠️ [COMMIT] Redirigiendo a fallback:', u.toString());
      return res.redirect(303, u.toString());
    }

    console.log('⚠️ [COMMIT] No hay WEBPAY_FINAL_URL, devolviendo JSON');
    return res.status(payload.ok ? 200 : (isOwnEvent ? 403 : 200)).json(payload);
  } catch (err: any) {
    console.error('commitPayment error:', err);
    return res.status(500).json({ error: err?.message || 'Error al confirmar el pago' });
  }
}

/**
 * POST /api/payments/capture
 * Body: { reservationId: number }
 * Debe ser llamado cuando el ADMIN aprueba el/los ticket(s) de la reserva.
 * - Verifica que Payment esté AUTHORIZED y no vencido.
 * - Ejecuta Transaction.capture(token, buy_order, authorization_code, amount).
 * - Si OK: Payment=CAPTURED, Reservation=PAID y crea Payout (PENDING) al organizador (si tiene ConnectedAccount).
 */
export async function capturePayment(req: Request, res: Response) {
  try {
    const reservationId = toInt(req.body?.reservationId);
    if (!reservationId) return res.status(400).json({ error: 'reservationId requerido' });

    // Carga Payment + Reserva + Organizador
    const payment = await prisma.payment.findFirst({
      where: { reservationId },
      include: {
        reservation: {
          include: {
            event: { select: { id: true, organizerId: true, price: true } }
          }
        },
        destinationAccount: true, // ConnectedAccount (si existe)
      },
    });
    if (!payment || !payment.reservation)
      return res.status(404).json({ error: 'Pago/reserva no encontrados' });

    if (payment.status !== 'AUTHORIZED')
      return res.status(400).json({ error: 'La transacción no está pre-autorizada' });

    if (!payment.token || !payment.buyOrder || !payment.authorizationCode)
      return res.status(400).json({ error: 'Faltan datos para capturar (token/buyOrder/authorizationCode)' });

    if (payment.authorizationExpiresAt && payment.authorizationExpiresAt < now())
      return res.status(400).json({ error: 'La autorización expiró; reintenta autorizar' });

    const captureAmount = payment.amount;

    // Ejecuta captura en Webpay
    const tx = tbkTx();
    const cap = await tx.capture(
      payment.token,
      payment.buyOrder,
      payment.authorizationCode,
      captureAmount
    );

    // cap.response_code === 0 indica captura exitosa
    const ok = cap?.response_code === 0;
    if (!ok) {
      return res.status(400).json({
        ok: false,
        error: 'Captura rechazada por el PSP',
        responseCode: cap?.response_code ?? null,
      });
    }

    // Posible fallback: si aún no hay destinationAccountId, tratamos de resolverlo ahora
    let destAccountId: number | null = payment.destinationAccountId ?? null;
    if (!destAccountId && payment.reservation?.event?.organizerId) {
      const acct = await prisma.connectedAccount.findUnique({
        where: { userId: payment.reservation.event.organizerId },
      });
      if (acct && acct.payoutsEnabled) destAccountId = acct.id;
    }

    // Suponemos comisión de aplicación 0 por ahora (ajústalo cuando definas tu modelo de fees)
    const applicationFeeAmount = payment.applicationFeeAmount ?? 0;
    const computedNet = Math.max(0, captureAmount - applicationFeeAmount);

    // Actualiza BD: Payment CAPTURED, Reservation PAID, crea Payout PENDING
    const updated = await prisma.$transaction(async (txp) => {
      const pay = await txp.payment.update({
        where: { id: payment.id },
        data: {
          status: 'CAPTURED',
          capturedAmount: captureAmount,
          capturedAt: now(),
          captureId: String(cap?.authorization_code ?? '') || null, // Transbank devuelve authorization_code para captura
          destinationAccountId: destAccountId ?? payment.destinationAccountId ?? null,
          // Si aún no teníamos netAmount, lo fijamos ahora con el cálculo simple
          netAmount: payment.netAmount ?? computedNet,
        },
        include: { reservation: true },
      });

      const resv = await txp.reservation.update({
        where: { id: pay.reservationId! },
        data: { status: 'PAID', paidAt: now(), fulfillmentStatus: 'TICKET_APPROVED', approvedAt: now() },
      });

      // Crea un Payout PENDING si hay cuenta conectada del organizador
      let payout = null;
      if (destAccountId) {
        const netAmountForPayout = pay.netAmount ?? computedNet;
        payout = await txp.payout.create({
          data: {
            accountId: destAccountId,
            reservationId: resv.id,
            paymentId: pay.id,
            amount: netAmountForPayout,
            status: 'PENDING',
            currency: 'CLP',
            idempotencyKey: newIdempotencyKey(), // <-- requerido por schema
          },
        });
      }

      return { pay, resv, payout };
    });

    // Procesar reserva FUERA de la transacción para evitar timeout
    // (generar PDF para OWN, marcar vendido para RESALE)
    try {
      await processReservationAfterPayment(updated.resv.id);
    } catch (pdfError) {
      console.error('Error procesando reserva después del pago:', pdfError);
      // No fallar la respuesta, el pago ya se confirmó
    }

    return res.status(200).json({
      ok: true,
      capturedAmount: captureAmount,
      paymentId: updated.pay.id,
      reservationId: updated.resv.id,
      payoutId: updated.payout?.id ?? null,
    });
  } catch (err: any) {
    console.error('capturePayment error:', err);
    return res.status(500).json({ error: err?.message || 'Error al capturar el pago' });
  }
}

/**
 * GET /api/payments/status/:token
 * Útil para pruebas: consulta estado en TBK y en nuestra BD.
 */
export async function getPaymentStatus(req: Request, res: Response) {
  try {
    const token = String(req.params?.token || '').trim();
    if (!token) return res.status(400).json({ error: 'token faltante' });

    const tx = tbkTx();
    const status = await tx.status(token).catch(() => null);

    const payment = await prisma.payment.findUnique({
      where: { token },
      include: { reservation: true },
    });
    if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });

    return res.status(200).json({
      token,
      tbkStatus: status, // puede ser null si TBK no lo encuentra
      local: {
        id: payment.id,
        status: payment.status,
        amount: payment.amount,
        buyOrder: payment.buyOrder,
        reservationId: payment.reservationId,
        updatedAt: payment.updatedAt,
        authorizationExpiresAt: payment.authorizationExpiresAt,
        capturedAt: payment.capturedAt,
      },
    });
  } catch (err: any) {
    console.error('getPaymentStatus error:', err);
    return res.status(500).json({ error: err?.message || 'Error obteniendo status' });
  }
}

/**
 * GET /api/payments/by-order/:buyOrder
 * Devuelve info local del pago (sin consultar TBK) — útil cuando el retorno fue abortado
 * y no tenemos token_ws, pero sí buyOrder en la URL.
 */
export async function getPaymentByBuyOrder(req: Request, res: Response) {
  try {
    const buyOrder = String(req.params?.buyOrder || '').trim();
    if (!buyOrder) return res.status(400).json({ error: 'buyOrder requerido' });

    const p = await prisma.payment.findFirst({
      where: { buyOrder },
      include: { reservation: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!p) return res.status(404).json({ error: 'Pago no encontrado' });

    return res.status(200).json({
      local: {
        id: p.id,
        status: p.status,
        amount: p.amount,
        buyOrder: p.buyOrder,
        reservationId: p.reservationId,
        updatedAt: p.updatedAt,
        authorizationExpiresAt: p.authorizationExpiresAt,
        capturedAt: p.capturedAt,
      },
    });
  } catch (err: any) {
    console.error('getPaymentByBuyOrder error:', err);
    return res.status(500).json({ error: err?.message || 'Error obteniendo pago por buyOrder' });
  }
}

/**
 * GET /api/payments/my-pending?eventId=123
 * Devuelve la reserva del usuario en PENDING_PAYMENT (no expirada) para el evento.
 * Sirve para mostrar el contador y permitir reanudar el pago.
 */
export async function getMyPending(req: Request, res: Response) {
  try {
    const userId = (req as any)?.user?.id as number | undefined;
    if (!userId) return res.status(401).json({ error: 'No autenticado' });

    const eventId = toInt(req.query?.eventId);
    if (!eventId) return res.status(400).json({ error: 'eventId requerido' });

    const r = await prisma.reservation.findFirst({
      where: {
        buyerId: userId,
        eventId,
        status: 'PENDING_PAYMENT',
        expiresAt: { gt: now() },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        eventId: true,
        quantity: true,
        amount: true,
        expiresAt: true,
        createdAt: true,
        event: { select: { title: true, date: true, price: true } },
      },
    });

    if (!r) {
      return res.status(200).json({ exists: false });
    }

    const lastPayment = await prisma.payment.findFirst({
      where: { reservationId: r.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, token: true, buyOrder: true, createdAt: true, authorizationExpiresAt: true },
    });

    const expMs = r.expiresAt ? new Date(r.expiresAt).getTime() : Date.now();
    const secondsLeft = Math.max(0, Math.floor((expMs - Date.now()) / 1000));

    return res.status(200).json({
      exists: true,
      reservation: {
        id: r.id,
        eventId: r.eventId,
        quantity: r.quantity,
        amount: r.amount,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
      },
      lastPayment,
      event: r.event,
      secondsLeft,
    });
  } catch (err: any) {
    console.error('getMyPending error:', err);
    return res
      .status(500)
      .json({ error: err?.message || 'Error buscando reserva pendiente' });
  }
}

/**
 * POST /api/payments/restart
 * Body: { reservationId: number }
 * Crea/actualiza la transacción Webpay reutilizando la misma reserva (si sigue vigente).
 */
export async function restartPayment(req: Request, res: Response) {
  try {
    const userId = (req as any)?.user?.id as number | undefined;
    if (!userId) return res.status(401).json({ error: 'No autenticado' });

    const reservationId = toInt(req.body?.reservationId);
    if (!reservationId) return res.status(400).json({ error: 'reservationId requerido' });

    if (!env.WEBPAY_RETURN_URL) {
      return res.status(500).json({ error: 'Falta configurar WEBPAY_RETURN_URL en .env' });
    }

    const reservation = await prisma.reservation.findFirst({
      where: {
        id: reservationId,
        buyerId: userId,
        status: 'PENDING_PAYMENT',
        expiresAt: { gt: now() },
      },
      include: { event: true },
    });

    if (!reservation) {
      return res.status(404).json({ error: 'Reserva no vigente' });
    }

    // 🚫 organizador no puede reintentar pago de su propio evento
    if (reservation.event && reservation.event.organizerId === userId) {
      return res.status(403).json({ error: 'CANNOT_BUY_OWN_EVENT' });
    }

    // Refrescar hold para dar tiempo al reintento
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: { expiresAt: minutesFromNow(HOLD_MINUTES) },
    });

    const buyOrder = makeBuyOrder(reservation.id);
    const sessionId = `u${userId}-r${reservation.id}-${Date.now().toString(36)}`;
    const amount = reservation.amount;

    const isProd = (env.WEBPAY_ENV || 'INTEGRATION').toUpperCase() === 'PRODUCTION';
    const commerceCodeForEnv = isProd
      ? (env.WEBPAY_COMMERCE_CODE || '')
      : IntegrationCommerceCodes.WEBPAY_PLUS_DEFERRED;

    // Busca payment por reservationId (único) y actualiza o crea
    let payment = await prisma.payment.findUnique({
      where: { reservationId: reservation.id },
    });

    if (payment) {
      if (payment.status === 'CAPTURED' || payment.status === 'COMMITTED') {
        return res.status(400).json({ error: 'La reserva ya fue pagada' });
      }
      payment = await prisma.payment.update({
        where: { id: payment.id },
        data: {
          amount,
          status: 'INITIATED',
          buyOrder,
          sessionId,
          token: null,
          authorizationCode: null,
          paymentTypeCode: null,
          installmentsNumber: null,
          responseCode: null,
          accountingDate: null,
          transactionDate: null,
          cardLast4: null,
          vci: null,
          environment: env.WEBPAY_ENV || 'INTEGRATION',
          commerceCode: commerceCodeForEnv,
          isDeferredCapture: true,
        },
      });
    } else {
      payment = await prisma.payment.create({
        data: {
          reservationId: reservation.id,
          amount,
          status: 'INITIATED',
          buyOrder,
          sessionId,
          environment: env.WEBPAY_ENV || 'INTEGRATION',
          commerceCode: commerceCodeForEnv,
          isDeferredCapture: true,
        },
      });
    }

    // Nueva transacción TBK
    const tx = tbkTx();
    const createResp = await tx.create(buyOrder, sessionId, amount, env.WEBPAY_RETURN_URL!);

    await prisma.payment.update({
      where: { id: payment.id },
      data: { token: createResp.token },
    });

    return res.status(200).json({
      url: createResp.url,
      token: createResp.token,
      reservationId: reservation.id,
      eventId: reservation.eventId,
      amount,
      holdExpiresAt: reservation.expiresAt,
    });
  } catch (err: any) {
    console.error('restartPayment error:', err);
    return res.status(500).json({ error: err?.message || 'Error reiniciando pago' });
  }
}

/**
 * POST /api/payments/refund
 * Body: { token?: string, buyOrder?: string, amount?: number }
 * - Sólo para transacciones capturadas (CAPTURED). Si no envías amount → reembolsa saldo pendiente.
 */
export async function refundPayment(req: Request, res: Response) {
  try {
    const token = String(req.body?.token ?? '').trim();
    const buyOrder = String(req.body?.buyOrder ?? '').trim();
    let amount = toInt(req.body?.amount, 0);

    let payment: any = null;

    if (token) {
      payment = await prisma.payment.findUnique({ where: { token } });
    } else if (buyOrder) {
      payment = await prisma.payment.findFirst({ where: { buyOrder } });
    }

    if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });
    if (payment.status !== 'CAPTURED' && payment.status !== 'REFUNDED')
      return res.status(400).json({ error: 'Solo se pueden reembolsar pagos capturados' });

    const already = payment.refundedAmount ?? 0;
    const maxRefundable = Math.max(0, payment.amount - already);
    if (amount <= 0) amount = maxRefundable;
    if (amount <= 0) return res.status(400).json({ error: 'Nada por reembolsar' });
    if (amount > maxRefundable)
      return res.status(400).json({ error: `Máximo reembolsable: ${maxRefundable}` });

    const tx = tbkTx();
    const tbkResp = await tx.refund(payment.token!, amount);

    const newRefunded = already + amount;
    const fullyRefunded = newRefunded >= payment.amount;

    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        refundedAmount: newRefunded,
        lastRefundAt: now(),
        status: fullyRefunded ? 'REFUNDED' : payment.status,
      },
    });

    return res.status(200).json({
      ok: true,
      refundedAmount: amount,
      totalRefunded: newRefunded,
      fullyRefunded,
      tbk: tbkResp,
      paymentId: updated.id,
    });
  } catch (err: any) {
    console.error('refundPayment error:', err);
    return res.status(500).json({ error: err?.message || 'Error al reembolsar' });
  }
}

/* ===================== Payouts ===================== */

/**
 * GET /api/payments/payouts/my?status=PENDING&page=1&pageSize=10&q=texto
 * Lista los payouts del organizador autenticado (y aprobado).
 */
export async function listMyPayouts(req: Request, res: Response) {
  try {
    const userId = (req as any)?.user?.id as number | undefined;
    if (!userId) return res.status(401).json({ error: 'No autenticado' });

    // ✅ verificación robusta compatible con tu schema
    const okOrganizer = await isOrganizerApprovedByDb(req);
    if (!okOrganizer) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'No aprobado como organizador' });
    }

    const page = Math.max(1, parseInt(String(req.query?.page ?? '1'), 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query?.pageSize ?? '10'), 10) || 10));
    const skip = (page - 1) * pageSize;

    // Filtro de status (opcional)
    const rawStatus = String(req.query?.status ?? '').trim().toUpperCase();
    const VALID = new Set(['PENDING', 'PAID', 'SCHEDULED', 'FAILED', 'IN_TRANSIT', 'CANCELED']);
    const status = VALID.has(rawStatus) ? rawStatus : undefined;

    // Search (q): numérico (ids) y texto (buyOrder, event.title)
    const q = String(req.query?.q ?? '').trim();
    const maybeId = Number(q);
    const isNumeric = Number.isFinite(maybeId);

    // Todas las cuentas conectadas del usuario (normalmente 1)
    const accounts = await prisma.connectedAccount.findMany({ where: { userId } });
    const accountIds = accounts.map(a => a.id);
    if (accountIds.length === 0) {
      return res.status(200).json({ items: [], total: 0, page, pageSize });
    }

    const where: any = { accountId: { in: accountIds } };
    if (status) where.status = status;

    if (q) {
      const or: any[] = [
        { payment: { buyOrder: { contains: q, mode: 'insensitive' } } },
        { reservation: { event: { title: { contains: q, mode: 'insensitive' } } } },
      ];
      if (isNumeric) {
        or.push({ id: maybeId });
        or.push({ paymentId: maybeId });
        or.push({ reservationId: maybeId });
      }
      where.OR = or;
    }

    const [total, rows] = await Promise.all([
      prisma.payout.count({ where }),
      prisma.payout.findMany({
        where,
        orderBy: { id: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          accountId: true,
          paymentId: true,
          reservationId: true,
          amount: true,
          currency: true,
          status: true,
          scheduledFor: true,
          paidAt: true,
          pspPayoutId: true,
          // contexto útil
          payment: { select: { buyOrder: true, netAmount: true, capturedAt: true } },
          reservation: {
            select: {
              id: true,
              event: { select: { id: true, title: true, date: true } },
            },
          },
        },
      }),
    ]);

    // Normalizamos un poco la respuesta
    const items = rows.map((p) => ({
      id: p.id,
      status: p.status,
      amount: p.amount,
      currency: p.currency,
      paidAt: p.paidAt,
      scheduledFor: p.scheduledFor,
      reservationId: p.reservationId,
      paymentId: p.paymentId,
      buyOrder: p.payment?.buyOrder ?? null,
      netAmount: p.payment?.netAmount ?? null,
      capturedAt: p.payment?.capturedAt ?? null,
      event: p.reservation?.event ?? null,
    }));

    return res.status(200).json({ items, total, page, pageSize });
  } catch (err: any) {
    console.error('listMyPayouts error:', err);
    return res.status(500).json({ error: err?.message || 'Error listando payouts' });
  }
}

/**
 * POST /api/payments/payouts/:id/mark-paid
 * Marca un payout como pagado (simulación). Idempotente.
 */
export async function adminMarkPayoutPaid(req: Request, res: Response) {
  try {
    const payoutId = Number(req.params.id);
    if (!Number.isFinite(payoutId)) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const p = await prisma.payout.findUnique({ where: { id: payoutId } });
    if (!p) return res.status(404).json({ error: 'Payout no encontrado' });

    // Idempotencia: si ya está pagado, responder OK
    if (p.status === 'PAID') {
      return res.status(200).json({
        ok: true,
        payout: p,
        note: 'Payout ya estaba marcado como pagado',
      });
    }

    const upd = await prisma.payout.update({
      where: { id: payoutId },
      data: {
        status: 'PAID',
        paidAt: now(),
        pspPayoutId: p.pspPayoutId ?? `SIM_PAID_${Date.now()}`,
      },
    });

    return res.status(200).json({ ok: true, payout: upd });
  } catch (err: any) {
    console.error('adminMarkPayoutPaid error:', err);
    return res.status(500).json({ error: err?.message || 'Error marcando payout como pagado' });
  }
}

// ===================== ADMIN: listar payouts =====================

/**
 * GET /api/payments/admin/payouts
 * Query:
 *  - page, pageSize
 *  - status: PENDING|PAID|SCHEDULED|FAILED|IN_TRANSIT|CANCELED
 *  - q: texto libre (buyOrder, título evento, pspPayoutId, nombre/email organizador) o número (ids)
 *  - organizerId?: filtra por organizador (userId)
 *  - eventId?: filtra por evento
 */
export async function adminListPayouts(req: Request, res: Response) {
  try {
    const page = Math.max(1, parseInt(String(req.query?.page ?? "1"), 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(String(req.query?.pageSize ?? "20"), 10) || 20)
    );
    const skip = (page - 1) * pageSize;

    const rawStatus = String(req.query?.status ?? "").trim().toUpperCase();
    const VALID = new Set(["PENDING", "PAID", "SCHEDULED", "FAILED", "IN_TRANSIT", "CANCELED"]);
    const status = VALID.has(rawStatus) ? rawStatus : undefined;

    const q = String(req.query?.q ?? "").trim();
    const maybeId = Number(q);
    const isNumeric = Number.isFinite(maybeId);

    const organizerId = Number(req.query?.organizerId);
    const hasOrganizer = Number.isFinite(organizerId);

    const eventId = Number(req.query?.eventId);
    const hasEvent = Number.isFinite(eventId);

    const where: any = {};

    if (status) where.status = status;
    if (hasOrganizer) {
      // filtra por el dueño de la ConnectedAccount
      where.account = { userId: organizerId };
    }
    if (hasEvent) {
      // filtra por evento asociado a la reserva
      where.reservation = { eventId };
    }

    if (q) {
      const OR: any[] = [
        { pspPayoutId: { contains: q } },
        { payment: { buyOrder: { contains: q } } },
        { reservation: { event: { title: { contains: q } } } },
        { account: { user: { name: { contains: q } } } },
        { account: { user: { email: { contains: q } } } },
      ];
      if (isNumeric) {
        OR.push({ id: maybeId });
        OR.push({ paymentId: maybeId });
        OR.push({ reservationId: maybeId });
        OR.push({ accountId: maybeId });
      }
      where.OR = OR;
    }

    const [total, rows] = await Promise.all([
      prisma.payout.count({ where }),
      prisma.payout.findMany({
        where,
        orderBy: { id: "desc" },
        skip,
        take: pageSize,
        select: {
          id: true,
          accountId: true,
          paymentId: true,
          reservationId: true,
          amount: true,
          currency: true,
          status: true,
          scheduledFor: true,
          paidAt: true,
          pspPayoutId: true,
          createdAt: true,
          updatedAt: true,
          // contexto
          account: {
            select: {
              userId: true,
              user: { select: { id: true, name: true, email: true } },
            },
          },
          payment: {
            select: { buyOrder: true, netAmount: true, capturedAt: true },
          },
          reservation: {
            select: {
              id: true,
              event: {
                select: {
                  id: true,
                  title: true,
                  date: true,
                  organizer: { select: { id: true, name: true, email: true } },
                },
              },
            },
          },
        },
      }),
    ]);

    const items = rows.map((p) => ({
      id: p.id,
      accountId: p.accountId,
      paymentId: p.paymentId,
      reservationId: p.reservationId,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      scheduledFor: p.scheduledFor,
      paidAt: p.paidAt,
      pspPayoutId: p.pspPayoutId,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      // extras
      buyOrder: p.payment?.buyOrder ?? null,
      netAmount: p.payment?.netAmount ?? null,
      capturedAt: p.payment?.capturedAt ?? null,
      event: p.reservation?.event
        ? { id: p.reservation.event.id, title: p.reservation.event.title, date: p.reservation.event.date }
        : null,
      organizer: p.reservation?.event?.organizer
        ? {
            id: p.reservation.event.organizer.id,
            name: p.reservation.event.organizer.name,
            email: p.reservation.event.organizer.email,
          }
        : (p as any).account?.user
        ? {
            id: (p as any).account.user.id,
            name: (p as any).account.user.name,
            email: (p as any).account.user.email,
          }
        : null,
    }));

    return res.status(200).json({ items, total, page, pageSize });
  } catch (err: any) {
    console.error("adminListPayouts error:", err);
    return res.status(500).json({ error: err?.message || "Error listando payouts (admin)" });
  }
}


/**
 * POST /api/payments/admin/payouts/run
 * Ejecuta pagos reales (driver http) contra el PSP o tu adapter.
 * Body/Query: { limit?: number }
 */
export async function adminRunPayoutsNow(req: Request, res: Response) {
  try {
    const limitRaw = (req.body?.limit ?? req.query?.limit) as any;
    const limit = Math.max(1, Math.min(500, toInt(limitRaw, 50)));

    const provider = getPayoutProvider();

    // Traemos PENDING (puedes incluir FAILED reintentables si quieres)
    const pendings = await prisma.payout.findMany({
      where: { status: 'PENDING' },
      orderBy: { id: 'asc' },
      take: limit,
      include: {
        account: true,
      },
    });

    if (pendings.length === 0) {
      return res.status(200).json({ ok: true, processed: 0, results: [] });
    }

    const results: Array<{
      payoutId: number;
      status?: string;
      paidAt?: string | null;
      error?: string | null;
    }> = [];

    const isAccountReady = (acc?: {
      payoutsEnabled: boolean;
      payoutBankName?: string | null;
      payoutAccountType?: string | null;
      payoutAccountNumber?: string | null;
      payoutHolderName?: string | null;
      payoutHolderRut?: string | null;
    }) =>
      !!acc?.payoutsEnabled &&
      !!acc?.payoutBankName &&
      !!acc?.payoutAccountType &&
      !!acc?.payoutAccountNumber &&
      !!acc?.payoutHolderName &&
      !!acc?.payoutHolderRut;

    for (const p of pendings) {
      try {
        // Validaciones mínimas
        if (!p.account) {
          await prisma.payout.update({
            where: { id: p.id },
            data: {
              status: 'FAILED',
              failureMessage: 'ConnectedAccount no encontrado',
            },
          });
          results.push({
            payoutId: p.id,
            error: 'ConnectedAccount no encontrado',
          });
          continue;
        }
        if (!isAccountReady(p.account)) {
          await prisma.payout.update({
            where: { id: p.id },
            data: {
              status: 'FAILED',
              failureMessage: 'Datos bancarios incompletos o payouts deshabilitados',
            },
          });
          results.push({
            payoutId: p.id,
            error: 'Datos bancarios incompletos o payouts deshabilitados',
          });
          continue;
        }

        // Mapeo de cuenta destino para el provider http
        const account = {
          bankName: p.account.payoutBankName!,
          accountType: String(p.account.payoutAccountType!) as any, // "VISTA"|"CORRIENTE"|"AHORRO"|"RUT"
          accountNumber: p.account.payoutAccountNumber!,
          holderName: p.account.payoutHolderName!,
          holderRut: p.account.payoutHolderRut!,
        };

        const idempotencyKey = `payout-${p.id}`; // idempotente por payout

        const out = await provider.pay({
          payoutId: p.id,
          amount: p.amount,
          currency: p.currency || 'CLP',
          account,
          idempotencyKey,
        });

        if (!out?.ok) {
          const msg = (out as any)?.error || 'Error no especificado por el PSP';
          await prisma.payout.update({
            where: { id: p.id },
            data: {
              status: 'FAILED',
              failureMessage: String(msg).slice(0, 250),
            },
          });
          results.push({ payoutId: p.id, error: String(msg) });
          continue;
        }

        // Éxito: guardamos pspPayoutId y avanzamos estado
        const nextStatus = (out as any).status || 'IN_TRANSIT';
        const paidAt =
          nextStatus === 'PAID'
            ? (out as any).paidAt
              ? new Date((out as any).paidAt)
              : now()
            : null;

        await prisma.payout.update({
          where: { id: p.id },
          data: {
            status: nextStatus as any,
            pspPayoutId: (out as any).pspPayoutId ?? p.pspPayoutId ?? null,
            paidAt: paidAt,
            failureCode: null,
            failureMessage: null,
          },
        });

        results.push({
          payoutId: p.id,
          status: String(nextStatus),
          paidAt: paidAt ? paidAt.toISOString() : null,
        });
      } catch (e: any) {
        const msg =
          e?.response?.data?.error ||
          e?.message ||
          'Fallo inesperado ejecutando payout';
        await prisma.payout.update({
          where: { id: p.id },
          data: {
            status: 'FAILED',
            failureMessage: String(msg).slice(0, 250),
          },
        });
        results.push({ payoutId: p.id, error: String(msg) });
      }
    }

    const processed = results.filter(
      (r) =>
        r.status === 'PAID' ||
        r.status === 'IN_TRANSIT' ||
        r.status === 'SCHEDULED'
    ).length;

    return res.status(200).json({ ok: true, processed, results });
  } catch (err: any) {
    console.error('adminRunPayoutsNow error:', err);
    return res
      .status(500)
      .json({ error: err?.message || 'Error ejecutando pagos' });
  }
}

/**
 * POST /api/payments/payouts/webhook
 * Webhook del PSP/adaptador para actualizar estado de un payout.
 * Debe venir sin auth JWT (usa firma/HMAC del PSP si aplica).
 */
export async function payoutsWebhook(req: Request, res: Response) {
  try {
    const provider = getPayoutProvider();

    // Verificación de firma (si el provider la implementa)
    const maybeRawBody: Buffer =
      (req as any)?.rawBody instanceof Buffer
        ? (req as any).rawBody
        : Buffer.from(JSON.stringify(req.body ?? {}), 'utf8');

    if (provider.verifyWebhookSignature) {
      const okSig = provider.verifyWebhookSignature(
        maybeRawBody,
        req.headers as Record<string, string | string[] | undefined>
      );
      if (!okSig) {
        return res.status(401).json({ ok: false, error: 'invalid signature' });
      }
    }

    // Si el provider no implementa parseWebhook, aceptamos sin acción
    if (!provider.parseWebhook) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const evt = await provider.parseWebhook(req.body);

    // Buscamos el payout por id interno o por id externo
    let payout = null;
    if ((evt as any).payoutId) {
      payout = await prisma.payout.findUnique({ where: { id: (evt as any).payoutId } });
    } else if ((evt as any).externalId) {
      payout = await prisma.payout.findFirst({
        where: { pspPayoutId: String((evt as any).externalId) },
      });
    }

    if (!payout) {
      // Evitamos 4xx para que el PSP no reintente indefinidamente
      return res.status(200).json({ ok: false, reason: 'payout not found' });
    }

    const data: any = {};
    if ((evt as any).externalId) data.pspPayoutId = String((evt as any).externalId);

    if ((evt as any).status) {
      const s = String((evt as any).status).toUpperCase();
      if (['PENDING', 'SCHEDULED', 'IN_TRANSIT', 'PAID', 'FAILED', 'CANCELED'].includes(s)) {
        data.status = s;
      }
      if (s === 'PAID') {
        data.paidAt = (evt as any).paidAt ? new Date((evt as any).paidAt) : now();
        data.failureCode = null;
        data.failureMessage = null;
      }
      if (s === 'FAILED') {
        data.failureCode = (evt as any).failureCode ?? null;
        data.failureMessage = (evt as any).failureMessage ?? 'Payout rechazado por PSP';
      }
    }

    await prisma.payout.update({
      where: { id: payout.id },
      data,
    });

    return res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error('payoutsWebhook error:', err);
    return res
      .status(200) // 200 para no provocar reintentos violentos
      .json({ ok: false, error: err?.message || 'error' });
  }
}

/* ============================================================
   ✅ ÚNICA función adminApproveAndCapture (unificada)
   - Si hay payment.pspPaymentId → captura/libera en PSP (split/escrow).
   - Si no, usa Webpay (TBK) capture().
   - Marca reserva como PAID y crea payout PENDING si corresponde.
   ============================================================ */
export async function adminApproveAndCapture(req: Request, res: Response) {
  try {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const adminId = (req as any)?.user?.id;

    // Cargamos reserva + pago + evento (para ubicar organizador)
    const r = await prisma.reservation.findUnique({
      where: { id: reservationId },
      include: {
        payment: true,
        event: { select: { organizerId: true, price: true } },
      },
    });
    if (!r) return res.status(404).json({ error: 'Reserva no encontrada' });

    // Debe estar TICKET_UPLOADED y debe existir el archivo
    if (r.fulfillmentStatus !== 'TICKET_UPLOADED') {
      return res
        .status(409)
        .json({ error: 'La reserva no está en estado TICKET_UPLOADED' });
    }
    if (!r.ticketFilePath || !fs.existsSync(path.resolve(r.ticketFilePath))) {
      return res.status(409).json({ error: 'Archivo no encontrado en servidor' });
    }

    // Validaciones del pago pre-autorizado
    const payment = r.payment;
    if (!payment) return res.status(409).json({ error: 'La reserva no tiene pago asociado' });
    if (payment.status !== 'AUTHORIZED') {
      return res.status(400).json({ error: 'La transacción no está pre-autorizada' });
    }
    if (!payment.token || !payment.buyOrder || !payment.authorizationCode) {
      return res
        .status(400)
        .json({ error: 'Faltan datos (token/buyOrder/authorizationCode)' });
    }
    if (payment.authorizationExpiresAt && payment.authorizationExpiresAt < new Date()) {
      return res.status(400).json({ error: 'La autorización expiró; reintenta autorizar' });
    }

    const captureAmount = payment.amount;

    // 1) Capturar en Webpay
    const tx = tbkTx();
    const cap = await tx.capture(
      payment.token,
      payment.buyOrder,
      payment.authorizationCode,
      captureAmount
    );
    if (!cap || cap.response_code !== 0) {
      return res.status(400).json({
        ok: false,
        error: 'Captura rechazada por el PSP',
        responseCode: cap?.response_code ?? null,
      });
    }

    // 2) Resolver cuenta conectada del organizador (si no estaba seteada en payment)
    let destAccountId: number | null = payment.destinationAccountId ?? null;
    if (!destAccountId && r.event?.organizerId) {
      const acct = await prisma.connectedAccount.findUnique({
        where: { userId: r.event.organizerId },
      });
      if (acct && acct.payoutsEnabled) destAccountId = acct.id;
    }

    // 3) Calcular neto (ajusta si tienes comisión)
    const applicationFeeAmount = payment.applicationFeeAmount ?? 0;
    const computedNet = Math.max(0, captureAmount - applicationFeeAmount);

    // 4) Actualizaciones atómicas: payment CAPTURED + reserva PAID + crear payout PENDING (si hay cuenta)
    const updated = await prisma.$transaction(async (txp) => {
      const pay = await txp.payment.update({
        where: { id: payment.id },
        data: {
          status: 'CAPTURED',
          capturedAmount: captureAmount,
          capturedAt: new Date(),
          captureId: String(cap?.authorization_code ?? '') || null, // TBK retorna authorization_code en capture
          destinationAccountId: destAccountId ?? payment.destinationAccountId ?? null,
          netAmount: payment.netAmount ?? computedNet,
        },
      });

      const resv = await txp.reservation.update({
        where: { id: r.id },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          fulfillmentStatus: 'TICKET_APPROVED',
          approvedAt: new Date(),
          approvedByAdminId: adminId ?? null,
          rejectionReason: null,
        },
      });

      let payout = null as null | { id: number; amount: number; currency: string; accountId: number };
      if (destAccountId) {
        const netAmountForPayout = pay.netAmount ?? computedNet;
        const created = await txp.payout.create({
          data: {
            accountId: destAccountId,
            reservationId: resv.id,
            paymentId: pay.id,
            amount: netAmountForPayout,
            status: 'PENDING',
            currency: 'CLP',
            source: 'INTERNAL',
            idempotencyKey: newIdempotencyKey(), // <-- requerido por schema
          },
          select: { id: true, amount: true, currency: true, accountId: true },
        });
        payout = created;
      }

      return { pay, resv, payout };
    });

    // 5) Disparo en caliente del payout (si existe)
    let payoutExec: any = null;
    if (updated.payout) {
      // Obtener datos bancarios del destinatario
      const account = await prisma.connectedAccount.findUnique({
        where: { id: updated.payout.accountId },
        select: {
          payoutsEnabled: true,
          payoutBankName: true,
          payoutAccountType: true,
          payoutAccountNumber: true,
          payoutHolderName: true,
          payoutHolderRut: true,
        },
      });

      const isAccountReady =
        !!account?.payoutsEnabled &&
        !!account?.payoutBankName &&
        !!account?.payoutAccountType &&
        !!account?.payoutAccountNumber &&
        !!account?.payoutHolderName &&
        !!account?.payoutHolderRut;

      if (!isAccountReady) {
        await prisma.payout.update({
          where: { id: updated.payout.id },
          data: {
            status: 'FAILED',
            failureMessage: 'Datos bancarios incompletos o payouts deshabilitados',
          },
        });
        payoutExec = { ok: false, error: 'Datos bancarios incompletos o payouts deshabilitados' };
      } else {
        const provider = getPayoutProvider();
        const idempotencyKey = `payout-${updated.payout.id}`;

        const out = await provider.pay({
          payoutId: updated.payout.id,
          amount: updated.payout.amount,
          currency: updated.payout.currency || 'CLP',
          account: {
            bankName: account.payoutBankName!,
            accountType: account.payoutAccountType as any,
            accountNumber: account.payoutAccountNumber!,
            holderName: account.payoutHolderName!,
            holderRut: account.payoutHolderRut!,
          },
          idempotencyKey,
        });

        // Persistir resultado
        if (!out.ok) {
          await prisma.payout.update({
            where: { id: updated.payout.id },
            data: {
              status: 'FAILED',
              failureMessage: String(out.error ?? 'Error no especificado por el PSP').slice(0, 250),
            },
          });
        } else {
          const nextStatus = (out.status as any) || 'IN_TRANSIT';
          await prisma.payout.update({
            where: { id: updated.payout.id },
            data: {
              status: nextStatus,
              pspPayoutId: out.pspPayoutId ?? undefined,
              paidAt:
                nextStatus === 'PAID'
                  ? out.paidAt
                    ? new Date(out.paidAt)
                    : new Date()
                  : null,
              failureCode: null,
              failureMessage: null,
            },
          });
        }

        payoutExec = out;
      }
    }

    return res.status(200).json({
      ok: true,
      capturedAmount: payment.amount,
      paymentId: updated.pay.id,
      reservationId: updated.resv.id,
      payout: updated.payout
        ? { id: updated.payout.id, exec: payoutExec }
        : null,
    });
  } catch (err: any) {
    console.error('adminApproveAndCapture error:', err);
    return res.status(500).json({ error: err?.message || 'Error aprobando y capturando' });
  }
}




















