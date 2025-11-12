// src/services/payout.service.ts
import prisma from '../prisma/client';
import { getPayoutProvider } from './payouts/provider';
import { generateIdempotencyKey } from './payment.service';

/* ===================== Tipos ===================== */

export type PayoutStatus =
  | 'PENDING'
  | 'SCHEDULED'
  | 'IN_TRANSIT'
  | 'PAID'
  | 'FAILED'
  | 'CANCELED';

export type AccountInfo = {
  bankName: string;
  accountType: 'VISTA' | 'CORRIENTE' | 'AHORRO' | 'RUT';
  accountNumber: string;
  holderName: string;
  holderRut: string;
};

export type ConnectedAccountData = {
  payoutsEnabled: boolean;
  payoutBankName: string | null;
  payoutAccountType: any | null;
  payoutAccountNumber: string | null;
  payoutHolderName: string | null;
  payoutHolderRut: string | null;
};

/* ===================== Validación ===================== */

/**
 * Verifica que una cuenta conectada esté lista para recibir payouts
 */
export function isAccountReady(acc?: ConnectedAccountData | null): boolean {
  if (!acc || !acc.payoutsEnabled) return false;
  
  return !!(
    acc.payoutBankName &&
    acc.payoutAccountType &&
    acc.payoutAccountNumber &&
    acc.payoutHolderName &&
    acc.payoutHolderRut
  );
}

/**
 * Lanza un error si la cuenta no está lista
 */
export function assertAccountReady(acc?: ConnectedAccountData | null): asserts acc {
  if (!acc || !acc.payoutsEnabled) {
    throw new Error('La cuenta del organizador no tiene payouts habilitados.');
  }
  if (!acc.payoutHolderName || !acc.payoutHolderRut) {
    throw new Error('Titular/RUT del destinatario incompleto.');
  }
  if (!acc.payoutBankName || !acc.payoutAccountNumber || !acc.payoutAccountType) {
    throw new Error('Datos bancarios incompletos (banco/tipo/número).');
  }
}

/* ===================== Creación de Payouts ===================== */

/**
 * Crea un registro de payout en estado PENDING
 */
export async function createPayout(params: {
  accountId: number;
  reservationId: number;
  paymentId: number;
  amount: number;
  currency?: string;
  source?: string;
  prismaClient?: any; // Para usar en transacciones
}) {
  const client = params.prismaClient || prisma;
  return await client.payout.create({
    data: {
      accountId: params.accountId,
      reservationId: params.reservationId,
      paymentId: params.paymentId,
      amount: params.amount,
      status: 'PENDING',
      currency: params.currency || 'CLP',
      source: params.source,
      idempotencyKey: generateIdempotencyKey('payout'),
    },
  });
}

/**
 * Encuentra una cuenta conectada activa para un organizador
 */
export async function getOrganizerConnectedAccount(userId: number) {
  return await prisma.connectedAccount.findUnique({
    where: { userId },
  });
}

/**
 * Calcula el monto neto que recibirá el organizador
 * 
 * Lógica de negocio:
 * - Organizador define precio base (lo que quiere recibir)
 * - Comprador paga: precio base + comisión de plataforma
 * - Organizador recibe: precio base (el monto que definió en el evento)
 * - Admin recibe: la comisión de plataforma
 * 
 * Prioriza Payment.netAmount si ya está calculado; si no, calcula desde applicationFeeAmount.
 */
export function calculateOrganizerNetAmount(payment: {
  amount: number;
  netAmount: number | null | undefined;
  applicationFeeAmount: number | null | undefined;
}): number {
  // Si ya tenemos netAmount precalculado (desde commit/capture), usarlo
  if (typeof payment.netAmount === 'number' && payment.netAmount > 0) {
    return payment.netAmount;
  }
  
  // Calcular: monto total que pagó el comprador - comisión para el admin
  const fee = typeof payment.applicationFeeAmount === 'number' ? payment.applicationFeeAmount : 0;
  const net = payment.amount - fee;
  
  // Nunca devolver negativo
  return net > 0 ? net : payment.amount;
}

/* ===================== Ejecución de Payouts ===================== */

/**
 * Marca un payout como pagado (simulación o confirmación manual)
 */
export async function markPayoutAsPaid(payoutId: number) {
  const existing = await prisma.payout.findUnique({ where: { id: payoutId } });
  
  if (!existing) {
    throw new Error('Payout no encontrado');
  }

  // Idempotencia: si ya está pagado, retornar el existente
  if (existing.status === 'PAID') {
    return {
      ok: true,
      payout: existing,
      note: 'Payout ya estaba marcado como pagado',
    };
  }

  const updated = await prisma.payout.update({
    where: { id: payoutId },
    data: {
      status: 'PAID',
      paidAt: new Date(),
      pspPayoutId: existing.pspPayoutId ?? `SIM_PAID_${Date.now()}`,
    },
  });

  return { ok: true, payout: updated };
}

/**
 * Ejecuta un payout individual mediante el provider configurado
 */
export async function executePayout(payoutId: number) {
  const payout = await prisma.payout.findUnique({
    where: { id: payoutId },
    include: { account: true },
  });

  if (!payout) {
    throw new Error('Payout no encontrado');
  }

  if (!payout.account) {
    throw new Error('ConnectedAccount no encontrado');
  }

  assertAccountReady(payout.account);

  const provider = getPayoutProvider();

  const account: AccountInfo = {
    bankName: payout.account.payoutBankName!,
    accountType: String(payout.account.payoutAccountType!) as any,
    accountNumber: payout.account.payoutAccountNumber!,
    holderName: payout.account.payoutHolderName!,
    holderRut: payout.account.payoutHolderRut!,
  };

  const idempotencyKey = payout.idempotencyKey || generateIdempotencyKey('payout');

  // Actualizar idempotencyKey si no tenía
  if (!payout.idempotencyKey) {
    await prisma.payout.update({
      where: { id: payout.id },
      data: { idempotencyKey },
    });
  }

  const response = await provider.pay({
    payoutId: payout.id,
    amount: payout.amount,
    currency: payout.currency || 'CLP',
    account,
    idempotencyKey,
  });

  // Actualizar estado según respuesta
  const updateData: any = {
    retries: response.ok ? payout.retries : (payout.retries || 0) + 1,
  };

  if (response.status) {
    updateData.status = response.status as PayoutStatus;
    updateData.externalStatus = response.status;
  } else if (response.ok) {
    updateData.status = 'IN_TRANSIT';
    updateData.externalStatus = 'IN_TRANSIT';
  }

  if (response.pspPayoutId && !payout.pspPayoutId) {
    updateData.pspPayoutId = response.pspPayoutId;
  }

  if (response.paidAt && (!payout.paidAt || updateData.status === 'PAID')) {
    updateData.paidAt = new Date(response.paidAt);
  }

  if (!response.ok && response.error) {
    updateData.failureMessage = String(response.error).slice(0, 500);
  }

  const updated = await prisma.payout.update({
    where: { id: payout.id },
    data: updateData,
  });

  return {
    ok: response.ok,
    payout: updated,
    response,
  };
}

/**
 * Ejecuta múltiples payouts pendientes (batch)
 */
export async function executePayoutsBatch(limit: number = 50) {
  const pendings = await prisma.payout.findMany({
    where: { status: 'PENDING' },
    orderBy: { id: 'asc' },
    take: Math.min(500, Math.max(1, limit)),
    include: { account: true },
  });

  if (pendings.length === 0) {
    return { ok: true, processed: 0, results: [] };
  }

  const results: Array<{
    payoutId: number;
    status?: string;
    paidAt?: string | null;
    error?: string | null;
  }> = [];

  for (const payout of pendings) {
    try {
      if (!payout.account) {
        await prisma.payout.update({
          where: { id: payout.id },
          data: {
            status: 'FAILED',
            failureMessage: 'ConnectedAccount no encontrado',
          },
        });
        results.push({
          payoutId: payout.id,
          error: 'ConnectedAccount no encontrado',
        });
        continue;
      }

      if (!isAccountReady(payout.account)) {
        await prisma.payout.update({
          where: { id: payout.id },
          data: {
            status: 'FAILED',
            failureMessage: 'Datos bancarios incompletos o payouts deshabilitados',
          },
        });
        results.push({
          payoutId: payout.id,
          error: 'Datos bancarios incompletos o payouts deshabilitados',
        });
        continue;
      }

      const result = await executePayout(payout.id);

      results.push({
        payoutId: payout.id,
        status: result.payout.status,
        paidAt: result.payout.paidAt?.toISOString() || null,
        error: result.ok ? null : (result.response.error || 'Error desconocido'),
      });
    } catch (err: any) {
      console.error(`Error ejecutando payout ${payout.id}:`, err);
      
      await prisma.payout.update({
        where: { id: payout.id },
        data: {
          status: 'FAILED',
          failureMessage: err.message || 'Error ejecutando payout',
          retries: (payout.retries || 0) + 1,
        },
      });

      results.push({
        payoutId: payout.id,
        error: err.message || 'Error ejecutando payout',
      });
    }
  }

  return {
    ok: true,
    processed: results.length,
    results,
  };
}

/* ===================== Consultas ===================== */

/**
 * Lista payouts de un organizador
 */
export async function listOrganizerPayouts(userId: number, filters?: {
  status?: PayoutStatus;
  page?: number;
  pageSize?: number;
  q?: string;
}) {
  const page = Math.max(1, filters?.page || 1);
  const pageSize = Math.min(50, Math.max(1, filters?.pageSize || 10));
  const skip = (page - 1) * pageSize;

  // Encontrar cuentas conectadas del usuario
  const accounts = await prisma.connectedAccount.findMany({
    where: { userId },
  });

  const accountIds = accounts.map(a => a.id);
  if (accountIds.length === 0) {
    return { items: [], total: 0, page, pageSize };
  }

  const where: any = { accountId: { in: accountIds } };

  if (filters?.status) {
    where.status = filters.status;
  }

  if (filters?.q) {
    const q = filters.q.trim();
    const maybeId = Number(q);
    const isNumeric = Number.isFinite(maybeId);

    const OR: any[] = [
      { payment: { buyOrder: { contains: q, mode: 'insensitive' } } },
      { reservation: { event: { title: { contains: q, mode: 'insensitive' } } } },
    ];

    if (isNumeric) {
      OR.push({ id: maybeId });
      OR.push({ paymentId: maybeId });
      OR.push({ reservationId: maybeId });
    }

    where.OR = OR;
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
        payment: {
          select: {
            buyOrder: true,
            netAmount: true,
            capturedAt: true,
          },
        },
        reservation: {
          select: {
            id: true,
            event: {
              select: {
                id: true,
                title: true,
                date: true,
              },
            },
          },
        },
      },
    }),
  ]);

  const items = rows.map(p => ({
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

  return { items, total, page, pageSize };
}

export default {
  isAccountReady,
  assertAccountReady,
  createPayout,
  getOrganizerConnectedAccount,
  calculateOrganizerNetAmount,
  markPayoutAsPaid,
  executePayout,
  executePayoutsBatch,
  listOrganizerPayouts,
};
