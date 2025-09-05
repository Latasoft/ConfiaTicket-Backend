// src/services/payouts/simulated.provider.ts
import type {
  PayoutProvider,
  PayoutRequest,
  PayoutPayResult,
  PayoutStatus,
} from "./provider";

export class SimulatedPayoutProvider implements PayoutProvider {
  /** Simula un pago instantáneo exitoso */
  async pay(req: PayoutRequest): Promise<PayoutPayResult> {
    return {
      ok: true,
      status: "PAID",
      pspPayoutId: `SIM_${req.payoutId}`,
      paidAt: new Date().toISOString(),
      error: null,
    };
  }

  /** En el simulador damos la firma por válida */
  verifyWebhookSignature(): boolean {
    return true;
  }

  /** Simula un webhook que marca el payout como pagado */
  parseWebhook(body: any): {
    externalId?: string | null;
    payoutId?: number | null;
    status?: PayoutStatus;
    paidAt?: string | null;
    failureCode?: string | null;
    failureMessage?: string | null;
  } {
    const payoutIdNum = Number(body?.payoutId);
    const allowed: PayoutStatus[] = [
      "PENDING",
      "SCHEDULED",
      "IN_TRANSIT",
      "PAID",
      "FAILED",
      "CANCELED",
    ];
    const raw = String(body?.status ?? "PAID").toUpperCase() as PayoutStatus;
    const status: PayoutStatus | undefined = allowed.includes(raw) ? raw : "PAID";

    return {
      externalId: String(body?.externalId || `SIM_${payoutIdNum || 0}`) || null,
      payoutId: Number.isFinite(payoutIdNum) ? payoutIdNum : null,
      status,
      paidAt: body?.paidAt ?? new Date().toISOString(),
      failureCode: body?.failureCode ?? null,
      failureMessage: body?.failureMessage ?? null,
    };
  }
}

