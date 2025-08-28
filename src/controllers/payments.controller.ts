// src/controllers/payments.controller.ts
import { Request, Response } from 'express';
import prisma from '../prisma/client';
import { env } from '../config/env';

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

const MAX_PER_PURCHASE = 4;
const HOLD_MINUTES = 15;

// ⏱️ Plazo para que el organizador suba el archivo (por defecto 24h)
const UPLOAD_DEADLINE_HOURS = (() => {
  const n = Number(env.TICKET_UPLOAD_DEADLINE_HOURS ?? 24);
  return Number.isFinite(n) && n > 0 ? n : 24;
})();

/** Configura una transacción de WebpayPlus con opciones según .env */
function tbkTx() {
  const envName = (env.WEBPAY_ENV || 'INTEGRATION').toUpperCase();
  const isProd = envName === 'PRODUCTION';
  const options = new Options(
    env.WEBPAY_COMMERCE_CODE || IntegrationCommerceCodes.WEBPAY_PLUS,
    env.WEBPAY_API_KEY || IntegrationApiKeys.WEBPAY,
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

    const eventId = toInt(req.body?.eventId);
    const requestedQty = Math.max(1, Math.min(MAX_PER_PURCHASE, toInt(req.body?.quantity, 1)));

    if (!eventId) return res.status(400).json({ error: 'eventId inválido' });
    if (!env.WEBPAY_RETURN_URL) {
      return res.status(500).json({ error: 'Falta configurar WEBPAY_RETURN_URL en .env' });
    }

    const { reservation, payment, event } = await prisma.$transaction(async (tx) => {
      const event = await tx.event.findUnique({ where: { id: eventId } });
      if (!event) throw new Error('Evento no encontrado');
      if (!event.approved) throw new Error('Evento no aprobado');
      if (new Date(event.date).getTime() <= Date.now()) throw new Error('El evento ya inició o finalizó');

      // 🚫 organizador no puede comprar su propio evento
      if (event.organizerId === userId) {
        const e: any = new Error('CANNOT_BUY_OWN_EVENT');
        e.status = 403;
        throw e;
      }

      // ¿Reserva pendiente vigente del usuario para este evento?
      let reservation =
        await tx.reservation.findFirst({
          where: {
            eventId,
            buyerId: userId,
            status: 'PENDING_PAYMENT',
            expiresAt: { gt: now() },
          },
          orderBy: { createdAt: 'desc' },
        });

      if (!reservation) {
        // Calcular disponibilidad actual
        const paidAgg = await tx.reservation.aggregate({
          _sum: { quantity: true },
          where: { eventId, status: 'PAID' },
        });
        const pendingAgg = await tx.reservation.aggregate({
          _sum: { quantity: true },
          where: { eventId, status: 'PENDING_PAYMENT', expiresAt: { gt: now() } },
        });

        const committed =
          (paidAgg._sum.quantity ?? 0) + (pendingAgg._sum.quantity ?? 0);
        const remaining = event.capacity - committed;
        if (remaining <= 0) throw new Error('Sin cupos disponibles');

        const qty = Math.min(requestedQty, remaining);
        if (qty < 1) throw new Error(`Solo quedan ${remaining} cupos disponibles`);

        const amount = (event.price || 0) * qty;

        reservation = await tx.reservation.create({
          data: {
            eventId,
            buyerId: userId,
            quantity: qty,
            status: 'PENDING_PAYMENT',
            amount,
            expiresAt: minutesFromNow(HOLD_MINUTES),
          },
        });
      } else {
        // Refrescar hold (no tocamos cantidad ni monto aquí para mantener consistencia)
        reservation = await tx.reservation.update({
          where: { id: reservation.id },
          data: { expiresAt: minutesFromNow(HOLD_MINUTES) },
        });
      }

      // Reusar/actualizar el Payment por reservationId (único)
      let payment = await tx.payment.findUnique({
        where: { reservationId: reservation.id },
      });

      const buyOrder = makeBuyOrder(reservation.id);
      const sessionId = `u${userId}-r${reservation.id}-${Date.now().toString(36)}`;
      const amount = reservation.amount;

      if (payment) {
        if (payment.status === 'COMMITTED') {
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
            commerceCode: env.WEBPAY_COMMERCE_CODE || IntegrationCommerceCodes.WEBPAY_PLUS,
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
            commerceCode: env.WEBPAY_COMMERCE_CODE || IntegrationCommerceCodes.WEBPAY_PLUS,
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
 * Responde JSON o redirige a WEBPAY_FINAL_URL si está configurada.
 */
export async function commitPayment(req: Request, res: Response) {
  try {
    const token = String(
      (req.body?.token_ws ?? req.query?.token_ws ?? '')
    ).trim();

    // Caso abortado por el usuario (puede venir por POST o GET)
    const tbkToken = String(
      (req.body?.TBK_TOKEN ?? req.query?.TBK_TOKEN ?? '')
    ).trim();

    if (!token && tbkToken) {
      const tbkOrder = String(
        (req.body?.TBK_ORDEN_COMPRA ?? req.query?.TBK_ORDEN_COMPRA ?? '')
      ).trim();

      let reservationId: number | undefined;
      let eventId: number | undefined;

      if (tbkOrder) {
        // Marcar como ABORTED y, si existe, obtener datos para el front
        const p = await prisma.payment.findFirst({
          where: { buyOrder: tbkOrder },
          include: { reservation: true },
          orderBy: { createdAt: 'desc' },
        });
        if (p) {
          // 🔧 null-safe
          reservationId = p.reservationId ?? undefined;
          eventId = p.reservation?.eventId ?? undefined;
          await prisma.payment.update({
            where: { id: p.id },
            data: { status: 'ABORTED' },
          });
        } else {
          // Si no lo encontramos, igual marcamos por buyOrder por si acaso
          await prisma.payment.updateMany({
            where: { buyOrder: tbkOrder },
            data: { status: 'ABORTED' },
          });
        }
      }

      const payload = {
        ok: false,
        aborted: true,
        error: 'Pago abortado por el usuario',
        buyOrder: tbkOrder || null,
        reservationId: reservationId ?? null,
        eventId: eventId ?? null,
      };

      if (env.WEBPAY_FINAL_URL) {
        const u = new URL(env.WEBPAY_FINAL_URL);
        u.searchParams.set('status', 'aborted');
        if (tbkOrder) u.searchParams.set('buyOrder', tbkOrder);
        if (reservationId) u.searchParams.set('reservationId', String(reservationId));
        if (eventId) u.searchParams.set('eventId', String(eventId));
        return res.redirect(303, u.toString());
      }
      return res.status(200).json(payload);
    }

    if (!token) return res.status(400).json({ error: 'token_ws faltante' });

    // Ejecuta commit en Webpay
    const tx = tbkTx();
    const commit = await tx.commit(token);

    // Busca el Payment por token + reserva + evento para validar "own event"
    const payment = await prisma.payment.findUnique({
      where: { token },
      include: { reservation: { include: { event: { select: { organizerId: true } } } } },
    });
    if (!payment) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    const isApproved = commit.response_code === 0;

    // ¿El comprador es el mismo organizador del evento?
    const isOwnEvent =
      !!payment.reservation &&
      payment.reservation.event?.organizerId === payment.reservation.buyerId;

    let uploadDeadlineAtISO: string | undefined;

    const updated = await prisma.$transaction(async (txp) => {
      // Siempre registramos los datos devueltos por TBK
      const p = await txp.payment.update({
        where: { id: payment.id },
        data: {
          status: isApproved && !isOwnEvent ? 'COMMITTED' : 'FAILED',
          authorizationCode: commit.authorization_code || null,
          paymentTypeCode: commit.payment_type_code || null,
          installmentsNumber: commit.installments_number ?? null,
          responseCode: commit.response_code ?? null,
          accountingDate: (commit.accounting_date as any) || null,
          transactionDate: (commit.transaction_date as any) || null,
          cardLast4: commit.card_detail?.card_number
            ? String(commit.card_detail.card_number).slice(-4)
            : null,
          vci: commit.vci || null,
        },
        include: { reservation: true },
      });

      const resId = p.reservationId;
      if (resId == null) throw new Error('Pago sin reserva asociada');

      if (isOwnEvent) {
        // 🔒 Salvaguarda: cancelar la reserva si es del propio evento
        await txp.reservation.update({
          where: { id: resId },
          data: { status: 'CANCELED' },
        });
        return p;
      }

      if (isApproved) {
        // Pago correcto → marcar como PAID, iniciar flujo de ticket y fijar plazo de subida
        const paidTime = now();
        const deadline = hoursFrom(paidTime, UPLOAD_DEADLINE_HOURS);

        const r = await txp.reservation.update({
          where: { id: resId },
          data: {
            status: 'PAID',
            paidAt: paidTime,
            fulfillmentStatus: 'WAITING_TICKET',
            ticketUploadDeadlineAt: deadline,
          } as any,
          select: { ticketUploadDeadlineAt: true },
        });

        uploadDeadlineAtISO = r.ticketUploadDeadlineAt
          ? new Date(r.ticketUploadDeadlineAt).toISOString()
          : undefined;
      } else {
        // Falló → liberar cupos
        await txp.reservation.update({
          where: { id: resId },
          data: { status: 'CANCELED' },
        });
      }

      return p;
    });

    const payload: any = {
      ok: isApproved && !isOwnEvent,
      token,
      buyOrder: updated.buyOrder,
      amount: updated.amount,
      authorizationCode: updated.authorizationCode,
      paymentTypeCode: updated.paymentTypeCode,
      installmentsNumber: updated.installmentsNumber,
      responseCode: commit.response_code,
      transactionDate: commit.transaction_date,
      cardLast4: updated.cardLast4,
      reservationId: updated.reservationId,
      ...(isOwnEvent ? { error: 'CANNOT_BUY_OWN_EVENT' } : null),
    };

    if (uploadDeadlineAtISO) {
      payload.uploadDeadlineAt = uploadDeadlineAtISO; // para el front
    }

    if (env.WEBPAY_FINAL_URL) {
      const u = new URL(env.WEBPAY_FINAL_URL);
      u.searchParams.set('status', payload.ok ? 'success' : (isOwnEvent ? 'own-event-forbidden' : 'failed'));
      u.searchParams.set('token', token);
      u.searchParams.set('buyOrder', updated.buyOrder);
      u.searchParams.set('amount', String(updated.amount));
      u.searchParams.set('reservationId', String(updated.reservationId));
      if (uploadDeadlineAtISO) u.searchParams.set('uploadDeadlineAt', uploadDeadlineAtISO);
      if (isOwnEvent) u.searchParams.set('error', 'CANNOT_BUY_OWN_EVENT');
      return res.redirect(303, u.toString());
    }

    return res.status(payload.ok ? 200 : (isOwnEvent ? 403 : 200)).json(payload);
  } catch (err: any) {
    console.error('commitPayment error:', err);
    return res.status(500).json({ error: err?.message || 'Error al confirmar el pago' });
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
      tbkStatus: status, // puede ser null si TBK no lo encuentra (p.ej. token inválido)
      local: {
        id: payment.id,
        status: payment.status,
        amount: payment.amount,
        buyOrder: payment.buyOrder,
        reservationId: payment.reservationId,
        updatedAt: payment.updatedAt,
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

    // Busca la reserva pendiente vigente
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

    // Último intento de pago asociado (opcional)
    const lastPayment = await prisma.payment.findFirst({
      where: { reservationId: r.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, token: true, buyOrder: true, createdAt: true },
    });

    // segundos restantes (maneja expiresAt nullable)
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
 * (Actualiza el Payment existente si ya hay uno para esa reservationId).
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

    // Busca payment por reservationId (único) y actualiza o crea
    let payment = await prisma.payment.findUnique({
      where: { reservationId: reservation.id },
    });

    if (payment) {
      if (payment.status === 'COMMITTED') {
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
          commerceCode: env.WEBPAY_COMMERCE_CODE || IntegrationCommerceCodes.WEBPAY_PLUS,
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
          commerceCode: env.WEBPAY_COMMERCE_CODE || IntegrationCommerceCodes.WEBPAY_PLUS,
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
 * - Si no envías amount → reembolsa el saldo pendiente (total menos lo ya reembolsado).
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
    if (payment.status !== 'COMMITTED')
      return res.status(400).json({ error: 'Solo se pueden reembolsar pagos confirmados' });

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








