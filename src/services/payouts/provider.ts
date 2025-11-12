// src/services/payouts/provider.ts
import { env } from "../../config/env";
import { SimulatedPayoutProvider } from "./simulated.provider";
import { HttpPayoutProvider } from "./http.provider";

/* ===================== Tipos base ===================== */

export type AccountType = "VISTA" | "CORRIENTE" | "AHORRO" | "RUT";

export type PayoutAccount = {
  bankName?: string | null;
  accountType?: AccountType | null;
  accountNumber?: string | null;
  holderName?: string | null;
  holderRut?: string | null;
};

export type PayoutRequest = {
  /** ID local del payout (tabla Payout.id) */
  payoutId: number;
  /** Monto en la moneda indicada (ej. CLP) */
  amount: number;
  /** Moneda, ej. "CLP", "USD" */
  currency: string;
  /** Datos de la cuenta de destino */
  account: PayoutAccount;
  /** Clave de idempotencia para reintentos seguros */
  idempotencyKey: string;
  /** (Opcional) Correlación de logs end-to-end; si no viene, el provider genera uno */
  requestId?: string;
};

export type PayoutStatus =
  | "PENDING"
  | "SCHEDULED"
  | "IN_TRANSIT"
  | "PAID"
  | "FAILED"
  | "CANCELED";

export type PayoutPayResult = {
  ok: boolean;
  status?: PayoutStatus;
  /** Identificador en el PSP/adaptador (se guarda en pspPayoutId) */
  pspPayoutId?: string | null;
  /** ISO datetime cuando quedó pagado (si aplica) */
  paidAt?: string | null;
  /** Mensaje de error (si aplica) */
  error?: string | null;
};

export type PayoutWebhookEvent = {
  /** ID externo (PSP) si está disponible */
  externalId?: string | null;
  /** ID local de payout si el PSP lo devuelve */
  payoutId?: number | null;
  /** Nuevo estado normalizado */
  status?: PayoutStatus;
  /** ISO datetime de pago confirmado (si aplica) */
  paidAt?: string | null;
  /** Código de falla (si aplica) */
  failureCode?: string | null;
  /** Mensaje de falla (si aplica) */
  failureMessage?: string | null;
};

export interface PayoutProvider {
  /** Ejecuta (o encola) un payout y devuelve un resultado normalizado */
  pay(req: PayoutRequest): Promise<PayoutPayResult>;

  /** Verificación opcional de firma de webhook */
  verifyWebhookSignature?(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>
  ): boolean;

  /** Parser opcional del webhook del PSP/adaptador */
  parseWebhook?(body: unknown): PayoutWebhookEvent | undefined;
}

/* ===================== Factory (singleton) ===================== */

let _singleton: PayoutProvider | null = null;

/** Devuelve una instancia única del provider configurado por env */
export function getPayoutProvider(): PayoutProvider {
  if (_singleton) return _singleton;

  // driver: 'sim' (default) | 'http'
  const driver = String(env.PAYOUTS_DRIVER ?? process.env.PAYOUTS_DRIVER ?? "manual").toLowerCase();

  if (driver === "http") {
    const baseUrl = String(env.PAYOUTS_HTTP_BASEURL ?? process.env.PAYOUTS_HTTP_BASEURL ?? "");
    const apiKey = String(env.PAYOUTS_HTTP_APIKEY ?? process.env.PAYOUTS_HTTP_APIKEY ?? "");
    const base: unknown = new HttpPayoutProvider(baseUrl, apiKey);
    _singleton = wrapProvider(base);
    return _singleton;
  }

  if (driver === "sim") {
    // Solo para desarrollo/testing
    const base: unknown = new SimulatedPayoutProvider();
    _singleton = wrapProvider(base);
    return _singleton;
  }

  // Por defecto: modo manual (no hace nada automáticamente)
  // Los pagos deben marcarse manualmente con adminMarkPayoutPaid
  _singleton = {
    async pay(): Promise<PayoutPayResult> {
      return {
        ok: false,
        error: "Payouts en modo manual. Use adminMarkPayoutPaid para marcar como pagado después de transferir.",
      };
    },
  };
  return _singleton;
}

/* ===================== Adapter: normaliza providers viejos ===================== */
/**
 * Permite que un provider legacy que exponga `enqueue()` en vez de `pay()`
 * siga funcionando y normaliza nombres de campos a la forma esperada.
 */
function wrapProvider(base: any): PayoutProvider {
  return {
    async pay(req: PayoutRequest): Promise<PayoutPayResult> {
      const raw =
        typeof base?.pay === "function"
          ? await base.pay(req)
          : typeof base?.enqueue === "function"
            ? await base.enqueue(req)
            : null;

      if (!raw) {
        return { ok: false, error: "Provider does not implement pay/enqueue" };
      }

      const status: PayoutStatus | undefined = raw.status ?? raw.state ?? undefined;

      const pspPayoutId: string | null =
        raw.pspPayoutId ?? raw.externalId ?? raw.id ?? null;

      // Normaliza paidAt a ISO string si viene Date
      const paidAt: string | null =
        raw.paidAt instanceof Date
          ? raw.paidAt.toISOString()
          : typeof raw.paidAt === "string"
            ? raw.paidAt
            : null;

      const error: string | null =
        raw.error ?? raw.failureMessage ?? raw.message ?? null;

      const ok: boolean =
        typeof raw.ok === "boolean" ? raw.ok : (status ? status !== "FAILED" : !error);

      return { ok, status, pspPayoutId, paidAt, error };
    },

    verifyWebhookSignature:
      typeof base?.verifyWebhookSignature === "function"
        ? base.verifyWebhookSignature.bind(base)
        : undefined,

    parseWebhook:
      typeof base?.parseWebhook === "function"
        ? (body: unknown): PayoutWebhookEvent | undefined => {
            const evt: any = base.parseWebhook(body);
            if (!evt || typeof evt !== "object") return undefined;

            // Normaliza campos y asegura tipos
            const payoutId =
              typeof evt.payoutId === "number"
                ? evt.payoutId
                : Number.isFinite(Number(evt.payoutId))
                  ? Number(evt.payoutId)
                  : null;

            const paidAt =
              evt.paidAt instanceof Date
                ? evt.paidAt.toISOString()
                : typeof evt.paidAt === "string"
                  ? evt.paidAt
                  : null;

            return {
              externalId: evt.externalId ?? evt.id ?? null,
              payoutId,
              status: evt.status ?? evt.state,
              paidAt,
              failureCode: evt.failureCode ?? null,
              failureMessage: evt.failureMessage ?? evt.error ?? null,
            };
          }
        : undefined,
  };
}



