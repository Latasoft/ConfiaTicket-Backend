// src/services/psp/provider.ts
import { env } from "../../config/env";

/* =========================================================
   Tipos y enums normalizados (alineados con tu schema Prisma)
   ========================================================= */

export type PaymentStatus =
  | "INITIATED"
  | "AUTHORIZED"
  | "CAPTURED"
  | "COMMITTED"
  | "VOIDED"
  | "FAILED"
  | "ABORTED"
  | "TIMEOUT"
  | "REFUNDED";

export type PaymentEscrowStatus = "NONE" | "HELD" | "RELEASED" | "RELEASE_FAILED" | "EXPIRED";
export type CapturePolicy = "IMMEDIATE" | "MANUAL_ON_APPROVAL";

export type Currency = "CLP" | "USD" | string;

/** Datos de la cuenta destino (vendedor) ya conectada en el PSP */
export type DestinationAccount = {
  /** FK a ConnectedAccount.id (tu DB) */
  destinationAccountId: number;
  /** ID de cuenta en el PSP (ej.: collector_id / merchant_id / account_id) */
  pspAccountId: string;
};

/** Reglas de split (fees del marketplace) */
export type SplitRule = {
  /** Basis points para la comisión de la plataforma (100 bps = 1%) */
  applicationFeeBps: number; // ej. 250 = 2.5%
};

/** Resultado del split calculado */
export type SplitBreakdown = {
  isSplit: boolean;
  grossAmount: number;
  applicationFeeAmount: number;
  netAmount: number;
};

/** Identificadores de negocio (idempotencia y tracking) */
export type BusinessRefs = {
  buyOrder: string;      // único (Payment.buyOrder)
  sessionId: string;     // tracking de sesión
  idempotencyKey?: string; // para reintentos seguros en el PSP
};

/** Metadatos libres que quieras enviar al PSP */
export type PSPMetadata = Record<string, any>;

/* ===================== Request / Response ===================== */

export type CreatePaymentRequest = {
  amount: number;
  currency?: Currency; // default: "CLP"
  capturePolicy?: CapturePolicy; // default: env.PSP_CAPTURE_POLICY
  destination: DestinationAccount;
  split: SplitRule;  // para calcular fee + neto
  refs: BusinessRefs;
  metadata?: PSPMetadata;
  /** Si el PSP soporta guardado de método/one-clicks, token, etc. */
  paymentMethodToken?: string;
};

export type CreatePaymentResult = {
  ok: boolean;
  status: PaymentStatus; // AUTHORIZED si es captura diferida; CAPTURED si inmediata
  isSplit: boolean;
  escrowStatus: PaymentEscrowStatus;
  pspPaymentId?: string | null; // ID principal del PSP (order/charge/transaction)
  pspChargeId?: string | null;  // si el PSP separa conceptos
  authorizedAmount?: number | null;
  authorizationExpiresAt?: string | null; // ISO
  error?: string | null;
  pspMetadata?: PSPMetadata; // payload/fragmentos útiles (no sensibles)
  // Cálculo de split redundante (para persistir en Payment.*)
  applicationFeeAmount?: number;
  netAmount?: number;
};

export type CapturePaymentRequest = {
  pspPaymentId: string;
  amount?: number; // si permitiera captura parcial
  idempotencyKey?: string;
};

export type CapturePaymentResult = {
  ok: boolean;
  status: PaymentStatus; // CAPTURED/COMMITTED
  escrowStatus: PaymentEscrowStatus; // RELEASED si aplica
  capturedAmount?: number | null;
  capturedAt?: string | null; // ISO
  captureId?: string | null;
  error?: string | null;
  pspMetadata?: PSPMetadata;
};

export type VoidAuthorizationRequest = {
  pspPaymentId: string;
  reason?: string;
  idempotencyKey?: string;
};

export type VoidAuthorizationResult = {
  ok: boolean;
  status: PaymentStatus; // VOIDED
  error?: string | null;
  pspMetadata?: PSPMetadata;
};

export type RefundPaymentRequest = {
  pspPaymentId: string;
  amount?: number; // total o parcial
  reason?: string;
  idempotencyKey?: string;
};

export type RefundPaymentResult = {
  ok: boolean;
  status: PaymentStatus; // REFUNDED (o FAILED si no procede)
  refundedAmount?: number | null;
  refundedAt?: string | null; // ISO
  error?: string | null;
  pspMetadata?: PSPMetadata;
};

/** Algunos PSP usan "release" en vez de "capture" para escrow */
export type ReleaseEscrowRequest = {
  pspPaymentId: string;
  idempotencyKey?: string;
};
export type ReleaseEscrowResult = {
  ok: boolean;
  escrowStatus: PaymentEscrowStatus; // RELEASED o RELEASE_FAILED
  releasedAt?: string | null; // ISO
  releaseId?: string | null;
  error?: string | null;
  pspMetadata?: PSPMetadata;
};

export type GetPaymentRequest = { pspPaymentId: string };
export type GetPaymentResult = {
  ok: boolean;
  status: PaymentStatus;
  escrowStatus: PaymentEscrowStatus;
  amount: number;
  currency: Currency;
  authorizedAmount?: number | null;
  capturedAmount?: number | null;
  refundedAmount?: number | null;
  createdAt?: string | null; // ISO
  updatedAt?: string | null; // ISO
  pspMetadata?: PSPMetadata;
};

/* ===================== Onboarding de vendedores ===================== */

export type StartOnboardingRequest = {
  userId: number; // tu User.id
  redirectUri: string; // callback en tu backend/frontend
  successUrl?: string;
  failureUrl?: string;
};
export type StartOnboardingResult = {
  ok: boolean;
  /** URL a la que rediriges al vendedor para conectar su cuenta en el PSP */
  connectUrl?: string;
  error?: string | null;
};

export type ParseOnboardingCallbackRequest = {
  /** Lo que te envía el PSP en el callback (query/body) */
  payload: Record<string, any>;
};
export type ParseOnboardingCallbackResult = {
  ok: boolean;
  pspAccountId?: string; // lo guardas en ConnectedAccount.pspAccountId
  payoutsEnabled?: boolean;
  onboardingStatus?: "PENDING" | "REQUIRED" | "COMPLETE" | "RESTRICTED";
  error?: string | null;
  pspMetadata?: PSPMetadata;
};

export type GetAccountStatusRequest = { pspAccountId: string };
export type GetAccountStatusResult = {
  ok: boolean;
  payoutsEnabled: boolean;
  onboardingStatus: "PENDING" | "REQUIRED" | "COMPLETE" | "RESTRICTED";
  pspMetadata?: PSPMetadata;
  error?: string | null;
};

/* ===================== Webhooks ===================== */

export type PSPWebhookEvent =
  | {
      type: "payment.updated";
      data: {
        pspPaymentId: string;
        status: PaymentStatus;
        escrowStatus: PaymentEscrowStatus;
        authorizedAmount?: number | null;
        capturedAmount?: number | null;
        refundedAmount?: number | null;
        failureCode?: string | null;
        failureMessage?: string | null;
        occurredAt?: string | null; // ISO
        metadata?: PSPMetadata;
      };
    }
  | {
      type: "account.updated";
      data: {
        pspAccountId: string;
        payoutsEnabled: boolean;
        onboardingStatus: "PENDING" | "REQUIRED" | "COMPLETE" | "RESTRICTED";
        occurredAt?: string | null;
        metadata?: PSPMetadata;
      };
    }
  | {
      type: "payout.updated"; // si el PSP emite eventos de desembolso
      data: {
        pspPayoutId: string;
        status: "PENDING" | "IN_TRANSIT" | "PAID" | "FAILED" | "CANCELED";
        failureCode?: string | null;
        failureMessage?: string | null;
        occurredAt?: string | null;
        metadata?: PSPMetadata;
      };
    };

export interface PspProvider {
  /* ====== Pagos (pay-in) ====== */
  createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult>;
  capturePayment(req: CapturePaymentRequest): Promise<CapturePaymentResult>;
  voidAuthorization(req: VoidAuthorizationRequest): Promise<VoidAuthorizationResult>;
  refundPayment(req: RefundPaymentRequest): Promise<RefundPaymentResult>;
  /** Algunos PSP usan release explícito del escrow (además o en vez de capture) */
  releaseEscrow?(req: ReleaseEscrowRequest): Promise<ReleaseEscrowResult>;
  getPayment(req: GetPaymentRequest): Promise<GetPaymentResult>;

  /* ====== Onboarding de cuentas destino ====== */
  startOnboarding(req: StartOnboardingRequest): Promise<StartOnboardingResult>;
  parseOnboardingCallback(
    req: ParseOnboardingCallbackRequest
  ): Promise<ParseOnboardingCallbackResult>;
  getAccountStatus(req: GetAccountStatusRequest): Promise<GetAccountStatusResult>;

  /* ====== Webhooks ====== */
  verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>
  ): boolean;

  parseWebhook(body: unknown): PSPWebhookEvent | PSPWebhookEvent[] | undefined;

  /* ====== Utilidades ====== */
  /** Calcula fee/neto según tus reglas de split (se persiste en Payment) */
  computeSplit(amount: number, rule: SplitRule): SplitBreakdown;
}

/* =========================================================
   Implementación simulada (para sandbox y pruebas locales)
   ========================================================= */

class SimulatedPspProvider implements PspProvider {
  private capturePolicy: CapturePolicy;
  private defaultCurrency: Currency;
  private appFeeBpsDefault: number;

  constructor() {
    this.capturePolicy = (env.PSP_CAPTURE_POLICY as CapturePolicy) ?? "MANUAL_ON_APPROVAL";
    this.defaultCurrency = "CLP";
    this.appFeeBpsDefault = Number.isFinite(Number(env.PSP_APP_FEE_BPS))
      ? Number(env.PSP_APP_FEE_BPS)
      : 0;
  }

  computeSplit(amount: number, rule: SplitRule): SplitBreakdown {
    const bps = Number.isFinite(rule?.applicationFeeBps)
      ? Math.max(0, rule.applicationFeeBps)
      : Math.max(0, this.appFeeBpsDefault);

    const applicationFeeAmount = Math.floor((amount * bps) / 10_000); // redondeo hacia abajo
    const netAmount = Math.max(0, amount - applicationFeeAmount);

    return {
      isSplit: bps > 0,
      grossAmount: amount,
      applicationFeeAmount,
      netAmount,
    };
  }

  async createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    const currency = (req.currency ?? this.defaultCurrency) as Currency;
    const capturePolicy = (req.capturePolicy ?? this.capturePolicy) as CapturePolicy;
    const split = this.computeSplit(req.amount, req.split);

    const now = new Date();
    const expires = new Date(now.getTime() + (Number(env.AUTH_HOLD_HOURS) || 72) * 3600 * 1000);

    const pspPaymentId = `sim_pay_${req.refs.buyOrder}`;
    const base: CreatePaymentResult = {
      ok: true,
      status: capturePolicy === "IMMEDIATE" ? "CAPTURED" : "AUTHORIZED",
      isSplit: split.isSplit,
      escrowStatus: capturePolicy === "IMMEDIATE" ? "RELEASED" : "HELD",
      pspPaymentId,
      pspMetadata: {
        provider: "SIM",
        currency,
        destinationAccountId: req.destination.destinationAccountId,
        pspAccountId: req.destination.pspAccountId,
      },
      authorizedAmount: req.amount,
      authorizationExpiresAt: capturePolicy === "MANUAL_ON_APPROVAL" ? expires.toISOString() : null,
      applicationFeeAmount: split.applicationFeeAmount,
      netAmount: split.netAmount,
    };

    // Captura inmediata simula "committed"
    if (base.status === "CAPTURED") {
      base.pspMetadata = { ...base.pspMetadata, capturedAt: now.toISOString() };
    }

    return base;
  }

  async capturePayment(req: CapturePaymentRequest): Promise<CapturePaymentResult> {
    const now = new Date();
    return {
      ok: true,
      status: "CAPTURED",
      escrowStatus: "RELEASED",
      capturedAmount: req.amount ?? undefined,
      capturedAt: now.toISOString(),
      captureId: `sim_capture_${req.pspPaymentId}`,
      pspMetadata: { provider: "SIM" },
    };
  }

  async voidAuthorization(req: VoidAuthorizationRequest): Promise<VoidAuthorizationResult> {
    return {
      ok: true,
      status: "VOIDED",
      pspMetadata: { provider: "SIM", voided: true },
    };
  }

  async refundPayment(req: RefundPaymentRequest): Promise<RefundPaymentResult> {
    const now = new Date();
    return {
      ok: true,
      status: "REFUNDED",
      refundedAmount: req.amount ?? undefined,
      refundedAt: now.toISOString(),
      pspMetadata: { provider: "SIM" },
    };
  }

  async releaseEscrow(req: ReleaseEscrowRequest): Promise<ReleaseEscrowResult> {
    const now = new Date();
    return {
      ok: true,
      escrowStatus: "RELEASED",
      releasedAt: now.toISOString(),
      releaseId: `sim_release_${req.pspPaymentId}`,
      pspMetadata: { provider: "SIM" },
    };
  }

  async getPayment(req: GetPaymentRequest): Promise<GetPaymentResult> {
    // Simulación básica: siempre "CAPTURED & RELEASED" al consultar
    const now = new Date().toISOString();
    return {
      ok: true,
      status: "CAPTURED",
      escrowStatus: "RELEASED",
      amount: 0,
      currency: "CLP",
      capturedAmount: 0,
      createdAt: now,
      updatedAt: now,
      pspMetadata: { provider: "SIM" },
    };
  }

  async startOnboarding(req: StartOnboardingRequest): Promise<StartOnboardingResult> {
    const url = `${env.FRONTEND_URL ?? ""}/organizer/payout-settings/sim-connect?user=${req.userId}`;
    return { ok: true, connectUrl: url };
  }

  async parseOnboardingCallback(
    _req: ParseOnboardingCallbackRequest
  ): Promise<ParseOnboardingCallbackResult> {
    // En el simulador damos por "conectado" al instante
    return {
      ok: true,
      pspAccountId: `sim_account_${Date.now()}`,
      payoutsEnabled: true,
      onboardingStatus: "COMPLETE",
      pspMetadata: { provider: "SIM" },
    };
  }

  async getAccountStatus(_req: GetAccountStatusRequest): Promise<GetAccountStatusResult> {
    return {
      ok: true,
      payoutsEnabled: true,
      onboardingStatus: "COMPLETE",
      pspMetadata: { provider: "SIM" },
    };
  }

  verifyWebhookSignature(_rawBody: Buffer, _headers: Record<string, string | string[] | undefined>): boolean {
    // Sim: no valida firma
    return true;
  }

  parseWebhook(body: unknown): PSPWebhookEvent | PSPWebhookEvent[] | undefined {
    if (!body || typeof body !== "object") return undefined;
    const now = new Date().toISOString();

    // Convención simple del simulador: { type, pspPaymentId, status }
    const b: any = body;

    if (b.type === "payment.updated" && typeof b.pspPaymentId === "string") {
      const status = (b.status as PaymentStatus) ?? "CAPTURED";
      const escrowStatus = (b.escrowStatus as PaymentEscrowStatus) ?? "RELEASED";
      return {
        type: "payment.updated",
        data: {
          pspPaymentId: b.pspPaymentId,
          status,
          escrowStatus,
          authorizedAmount: b.authorizedAmount ?? null,
          capturedAmount: b.capturedAmount ?? null,
          refundedAmount: b.refundedAmount ?? null,
          failureCode: b.failureCode ?? null,
          failureMessage: b.failureMessage ?? null,
          occurredAt: b.occurredAt ?? now,
          metadata: { provider: "SIM" },
        },
      };
    }

    if (b.type === "account.updated" && typeof b.pspAccountId === "string") {
      return {
        type: "account.updated",
        data: {
          pspAccountId: b.pspAccountId,
          payoutsEnabled: !!b.payoutsEnabled,
          onboardingStatus: (b.onboardingStatus as any) ?? "COMPLETE",
          occurredAt: b.occurredAt ?? now,
          metadata: { provider: "SIM" },
        },
      };
    }

    if (b.type === "payout.updated" && typeof b.pspPayoutId === "string") {
      return {
        type: "payout.updated",
        data: {
          pspPayoutId: b.pspPayoutId,
          status: b.status ?? "PAID",
          failureCode: b.failureCode ?? null,
          failureMessage: b.failureMessage ?? null,
          occurredAt: b.occurredAt ?? now,
          metadata: { provider: "SIM" },
        },
      };
    }

    return undefined;
  }
}

/* ================================================
   Factory (singleton) – resuelve el provider real
   ================================================ */

let _singleton: PspProvider | null = null;

export function getPspProvider(): PspProvider {
  if (_singleton) return _singleton;

  const provider = String(env.PSP_PROVIDER ?? "MP").toUpperCase();

  // Aquí, más adelante, podrás sustituir por proveedores reales:
  // if (provider === "MP") _singleton = new MercadoPagoProvider(...);
  // if (provider === "KUSHKI") _singleton = new KushkiProvider(...);

  // Por ahora, usa el simulador para que el resto del backend funcione de punta a punta.
  _singleton = new SimulatedPspProvider();

  if (provider !== "SIM" && process.env.NODE_ENV !== "test") {
    // Aviso gentil para log
    // eslint-disable-next-line no-console
    console.warn(`[psp] PSP_PROVIDER=${provider} no está implementado aún; usando simulador.`);
  }
  return _singleton;
}
