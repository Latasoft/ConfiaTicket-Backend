// src/services/payouts/http.provider.ts
import { request as httpsRequest } from "https";
import { request as httpRequest } from "http";
import { URL } from "url";
import type {
  PayoutProvider,
  PayoutRequest,
  PayoutPayResult,
  PayoutStatus,
} from "./provider";

/** Config por defecto para producción */
const DEFAULT_CFG = {
  maxAttempts: 4,              // 1 intento + 3 reintentos
  initialDelayMs: 300,         // backoff inicial
  maxDelayMs: 4000,            // backoff máximo
  requestTimeoutMs: 10000,     // timeout total de request
  userAgent: "portal-entradas/1.0 payout-http-provider",
};

/** Espera async */
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Backoff exponencial con jitter */
function backoff(attempt: number, base: number, max: number) {
  const exp = Math.min(max, base * Math.pow(2, attempt - 1));
  const jitter = 0.5 + Math.random(); // 0.5 - 1.5
  return Math.min(max, Math.floor(exp * jitter));
}

/** Intenta parsear Retry-After (segundos o fecha HTTP) */
function parseRetryAfter(h?: string | string[]): number | null {
  if (!h) return null;
  const v = Array.isArray(h) ? h[0] : h;
  if (!v) return null;
  const asInt = Number(v);
  if (Number.isFinite(asInt)) return Math.max(0, asInt * 1000);
  const date = Date.parse(v);
  if (Number.isFinite(date)) {
    const diff = date - Date.now();
    return diff > 0 ? diff : 0;
  }
  return null;
}

/** Genera un request-id simple si el caller no provee uno */
function genRequestId() {
  // No dependemos de crypto; suficiente para correlación de logs.
  return `req_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/** POST JSON con soporte http/https, timeout y retorno status+json+headers */
function postJson(
  urlStr: string,
  body: any,
  headers: Record<string, string> = {},
  requestTimeoutMs = DEFAULT_CFG.requestTimeoutMs
): Promise<{ status: number; json: any; raw: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlStr);
      const data = Buffer.from(JSON.stringify(body));
      const isHttps = url.protocol === "https:";
      const reqFn = isHttps ? httpsRequest : httpRequest;

      const opts = {
        method: "POST",
        hostname: url.hostname,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: url.pathname + (url.search || ""),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(data.length),
          ...headers,
        },
      };

      const req = reqFn(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(timer);
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            const json = raw ? JSON.parse(raw) : {};
            resolve({ status: res.statusCode || 0, json, raw, headers: res.headers as any });
          } catch {
            resolve({ status: res.statusCode || 0, json: null, raw, headers: res.headers as any });
          }
        });
      });

      // Timeout duro (incluye conexión y lectura)
      const timer = setTimeout(() => {
        req.destroy(new Error("Request timeout"));
      }, requestTimeoutMs);

      req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      req.write(data);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

/** Determina si conviene reintentar según status / error */
function shouldRetry(
  status: number,
  body: any
): boolean {
  if (status === 0) return true;          // fallas de red
  if (status === 408) return true;        // Request Timeout
  if (status === 409) {
    // Conflicto puede ser reintento idempotente en algunos adapters/PSP
    // Si el body indica que ya existe y es seguro, NO reintentes.
    const msg = String(body?.message ?? body?.error ?? "").toLowerCase();
    if (msg.includes("idempot") && (msg.includes("replay") || msg.includes("already"))) {
      return false;
    }
    return true;
  }
  if (status === 429) return true;        // Rate Limited
  if (status >= 500) return true;         // 5xx transitorio
  return false;
}

/** Normaliza un estado textual cualquiera a PayoutStatus si coincide */
function normalizeStatus(raw: any): PayoutStatus | undefined {
  const s = String(raw ?? "").toUpperCase();
  const allowed = ["PENDING", "SCHEDULED", "IN_TRANSIT", "PAID", "FAILED", "CANCELED"] as const;
  return (allowed as readonly string[]).includes(s) ? (s as PayoutStatus) : undefined;
}

type ProviderCfg = typeof DEFAULT_CFG & {
  userAgent?: string;
};

export class HttpPayoutProvider implements PayoutProvider {
  private baseUrl: string;
  private apiKey?: string;
  private cfg: ProviderCfg;

  constructor(baseUrl: string, apiKey?: string, opts?: Partial<ProviderCfg>) {
    const trimmed = (baseUrl || "").trim();
    this.baseUrl = trimmed.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.cfg = { ...DEFAULT_CFG, ...(opts || {}) };
  }

  /** Ejecuta el payout contra tu adaptador/PSP vía HTTP con reintentos y backoff */
  async pay(req: PayoutRequest): Promise<PayoutPayResult> {
    if (!this.baseUrl) {
      return {
        ok: false,
        error:
          "HttpPayoutProvider no está configurado (baseUrl vacío). Usa driver 'sim' o configura PAYOUTS_HTTP_BASEURL.",
      };
    }

    // Endpoint del adapter: {BASE}/payouts
    const url = `${this.baseUrl}/payouts`;

    // Payload estándar para el adapter (tu adapter mapea a Kushki/PSP)
    const payload = {
      amount: req.amount,
      currency: (req.currency || "CLP").toUpperCase(),
      destination: {
        bankName: req.account.bankName,
        accountType: req.account.accountType, // "VISTA"|"CORRIENTE"|"AHORRO"|"RUT"
        accountNumber: req.account.accountNumber,
        holderName: req.account.holderName,
        holderRut: req.account.holderRut,
      },
      metadata: {
        payoutId: req.payoutId,
      },
    };

    const requestId = req.requestId || genRequestId();
    const headers: Record<string, string> = {
      "User-Agent": this.cfg.userAgent || DEFAULT_CFG.userAgent,
      "X-Request-Id": requestId,
    };
    if (req.idempotencyKey) headers["X-Idempotency-Key"] = req.idempotencyKey;
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    let attempt = 0;
    let lastError: any = null;

    while (attempt < this.cfg.maxAttempts) {
      attempt++;
      try {
        const resp = await postJson(url, payload, headers, this.cfg.requestTimeoutMs);
        const okHttp = resp.status >= 200 && resp.status < 300;
        const body = resp.json || {};

        // Normalización de campos comunes
        const status: PayoutStatus | undefined =
          normalizeStatus(body?.status ?? body?.state) ?? (okHttp ? "IN_TRANSIT" : undefined);

        const pspPayoutId: string | null =
          body?.pspPayoutId ?? body?.externalId ?? body?.id ?? body?.reference ?? null;

        const paidAt: string | null =
          typeof body?.paidAt === "string" ? body.paidAt : null;

        const errorMsg: string | null =
          body?.error ??
          body?.failureMessage ??
          body?.message ??
          (okHttp ? null : `HTTP ${resp.status}`);

        // Si el adapter respondió explícitamente ok
        const okField = typeof body?.ok === "boolean" ? body.ok : undefined;
        const ok: boolean =
          okField !== undefined
            ? okField
            : status
            ? status !== "FAILED"
            : !!okHttp && !errorMsg;

        // Idempotent replay típico (no es error)
        const msg = String(errorMsg || "").toLowerCase();
        const isIdempotentReplay =
          resp.status === 409 &&
          (msg.includes("idempot") || msg.includes("already"));

        if (ok || isIdempotentReplay) {
          return { ok: true, status, pspPayoutId, paidAt, error: null };
        }

        // Si no es ok, decidir si reintentamos
        if (!shouldRetry(resp.status, body)) {
          return { ok: false, status, pspPayoutId, paidAt, error: errorMsg || "Falla en payout" };
        }

        // Respetar Retry-After si viene
        const retryAfterMs = parseRetryAfter(resp.headers["retry-after"]);
        const delay =
          typeof retryAfterMs === "number"
            ? Math.min(retryAfterMs, this.cfg.maxDelayMs)
            : backoff(attempt, this.cfg.initialDelayMs, this.cfg.maxDelayMs);

        await sleep(delay);
        continue;
      } catch (e: any) {
        lastError = e;
        // Falla de red/timeout → reintentar con backoff si quedan intentos
        if (attempt >= this.cfg.maxAttempts) {
          break;
        }
        const delay = backoff(attempt, this.cfg.initialDelayMs, this.cfg.maxDelayMs);
        await sleep(delay);
      }
    }

    return {
      ok: false,
      error:
        lastError?.message ||
        "Falla HTTP al invocar el adaptador de payouts (sin respuesta exitosa tras reintentos)",
    };
  }

  /** Firma del webhook: implementa si tu PSP/adaptador la exige (noop aquí) */
  verifyWebhookSignature(): boolean {
    return false;
  }

  /** Parser del webhook de tu PSP/adaptador (opcional y genérico) */
  parseWebhook(body: any): {
    externalId?: string | null;
    payoutId?: number | null;
    status?: PayoutStatus;
    paidAt?: string | null;
    failureCode?: string | null;
    failureMessage?: string | null;
  } {
    const payoutIdNum = Number(body?.payoutId);
    const st = normalizeStatus(body?.status ?? body?.state);

    return {
      externalId: body?.externalId ?? body?.pspPayoutId ?? body?.reference ?? body?.id ?? null,
      payoutId: Number.isFinite(payoutIdNum) ? payoutIdNum : null,
      status: st,
      paidAt: typeof body?.paidAt === "string" ? body.paidAt : null,
      failureCode: body?.failureCode ?? null,
      failureMessage: body?.failureMessage ?? body?.error ?? null,
    };
  }
}





