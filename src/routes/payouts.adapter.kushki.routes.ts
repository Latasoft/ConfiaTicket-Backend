// src/routes/payouts.adapter.kushki.routes.ts
import express, { Router, Request, Response } from "express";
import { env } from "../config/env";
import { request as httpsRequest } from "https";
import { URL } from "url";
import { createHmac, timingSafeEqual } from "crypto";
import prisma from "../prisma/client";

/**
 * Adapter HTTP para Payouts vía Kushki.
 * - POST /adapter/kushki/payouts       ← lo invoca tu HttpPayoutProvider
 * - GET  /adapter/kushki/payouts/:id   ← estado de un payout externo (para reconcile)
 * - GET  /adapter/kushki/payouts?externalId=... ← variante por query
 * - POST /adapter/kushki/webhooks      ← callback de Kushki (firma HMAC)
 */

const router = Router();

/* ======================= Tipos ======================= */

type PayoutStatus =
  | "PENDING"
  | "SCHEDULED"
  | "IN_TRANSIT"
  | "PAID"
  | "FAILED"
  | "CANCELED";

type IncomingBody = {
  amount: number;
  currency?: string;
  destination: {
    bankName?: string | null;
    accountType?: "VISTA" | "CORRIENTE" | "AHORRO" | "RUT" | null;
    accountNumber?: string | null;
    holderName?: string | null;
    holderRut?: string | null;
  };
  metadata?: Record<string, any>;
};

/* ======================= Helpers ======================= */

function bad(res: Response, code: number, msg: string) {
  return res.status(code).json({ ok: false, error: msg });
}
function cleanRut(v?: string | null) {
  return (v ?? "").replace(/[.\-]/g, "").trim().toUpperCase();
}
/** Mapea el tipo local a uno genérico para el PSP */
function mapAccountType(t?: string | null) {
  const s = String(t ?? "").toUpperCase();
  if (s === "CORRIENTE") return "CHECKING";
  if (s === "AHORRO") return "SAVINGS";
  if (s === "VISTA" || s === "RUT") return "SIGHT";
  return "CHECKING";
}
/** POST JSON */
function postJson(
  urlStr: string,
  body: any,
  headers: Record<string, string>
) {
  return new Promise<{ status: number; json: any; raw: string }>((resolve, reject) => {
    try {
      const url = new URL(urlStr);
      const data = Buffer.from(JSON.stringify(body));
      const opts = {
        method: "POST",
        hostname: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: url.pathname + (url.search || ""),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(data.length),
          ...headers,
        },
      };
      const req = httpsRequest(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            const json = raw ? JSON.parse(raw) : {};
            resolve({ status: res.statusCode || 0, json, raw });
          } catch {
            resolve({ status: res.statusCode || 0, json: null, raw });
          }
        });
      });
      req.on("error", reject);
      req.write(data);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}
/** GET JSON (para consultar estado) */
function getJson(urlStr: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; json: any; raw: string }>((resolve, reject) => {
    try {
      const url = new URL(urlStr);
      const opts = {
        method: "GET",
        hostname: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: url.pathname + (url.search || ""),
        headers,
      };
      const req = httpsRequest(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            const json = raw ? JSON.parse(raw) : {};
            resolve({ status: res.statusCode || 0, json, raw });
          } catch {
            resolve({ status: res.statusCode || 0, json: null, raw });
          }
        });
      });
      req.on("error", reject);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

/** Base URL según env */
function kushkiBaseUrl() {
  const envName = String(env.KUSHKI_ENV ?? "TEST").toUpperCase();
  return envName === "PROD" || envName === "PRODUCTION"
    ? "https://api.kushkipagos.com"
    : "https://api-uat.kushkipagos.com";
}
/** Path de creación de payouts (puede variarlo tu vertical) */
function kushkiPayoutsPath() {
  return process.env.KUSHKI_PAYOUTS_PATH || "/transfer/v1/payouts";
}
/** Path de status: por defecto /transfer/v1/payouts/:externalId, pero lo puedes sobreescribir */
function kushkiPayoutsStatusPath(externalId: string) {
  if (process.env.KUSHKI_PAYOUTS_STATUS_PATH) {
    // Si te dieron un path específico, úsalo (permite placeholders :id)
    return process
      .env
      .KUSHKI_PAYOUTS_STATUS_PATH!
      .replace(/:id\b/g, encodeURIComponent(externalId));
  }
  // Default genérico: mismo path + /:id
  const base = kushkiPayoutsPath().replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(externalId)}`;
}

/** Safe compare HEX (HMAC) */
function safeEq(a: string, b: string) {
  const A = Buffer.from(a, "hex");
  const B = Buffer.from(b, "hex");
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

/* ======================= Rutas ======================= */

/** Health simple del adapter */
router.get("/health", (_req, res) => {
  return res
    .status(200)
    .json({ ok: true, provider: "kushki-adapter", env: env.KUSHKI_ENV ?? "TEST" });
});

/** Endpoint que invoca tu HttpPayoutProvider: POST /adapter/kushki/payouts */
router.post("/payouts", async (req: Request, res: Response) => {
  try {
    // 1) Autorización interna del adapter
    const auth = String(req.headers.authorization || "").trim();
    const expected = env.PAYOUTS_HTTP_APIKEY ? `Bearer ${env.PAYOUTS_HTTP_APIKEY}` : "";
    if (expected && auth !== expected) {
      return bad(res, 401, "Unauthorized (adapter key)");
    }

    // 2) Validación de payload recibido desde tu backend
    const b = req.body as IncomingBody;
    const payoutId = (b?.metadata as any)?.payoutId ?? undefined;

    if (!b || typeof b.amount !== "number" || b.amount <= 0) {
      return bad(res, 400, "amount inválido");
    }
    const currency = (b.currency || "CLP").toUpperCase();

    const dest = b.destination || {};
    const holderName = (dest.holderName || "").trim();
    const holderRut = cleanRut(dest.holderRut);
    const bankName = (dest.bankName || "").trim();
    const accountNumber = String(dest.accountNumber || "").replace(/\D/g, "");
    const accountType = mapAccountType(dest.accountType);

    if (!holderName) return bad(res, 400, "holderName requerido");
    if (!holderRut) return bad(res, 400, "holderRut requerido");
    if (!bankName) return bad(res, 400, "bankName requerido");
    if (!accountNumber) return bad(res, 400, "accountNumber requerido");

    // 3) Validación de credenciales del PSP
    const privId = env.KUSHKI_PRIVATE_MERCHANT_ID;
    if (!privId) {
      return bad(res, 500, "KUSHKI_PRIVATE_MERCHANT_ID no configurado");
    }

    // 4) Armar request para Kushki (estructura tentativa; ajusta a tu spec)
    const bodyForKushki: any = {
      amount: { currency, total: b.amount },
      recipient: {
        name: holderName,
        documentType: "RUT",
        documentNumber: holderRut,
        bankName,
        accountType, // CHECKING | SAVINGS | SIGHT
        accountNumber,
      },
      metadata: { payoutId },
    };

    // 5) Headers para Kushki
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Private-Merchant-Id": privId,
    };

    // Idempotencia: propagamos la que nos envió el backend
    const idem = String(req.headers["x-idempotency-key"] || "").trim();
    if (idem) headers["X-Idempotency-Key"] = idem;

    // 6) Llamar a Kushki
    const base = kushkiBaseUrl();
    const path = kushkiPayoutsPath();
    const url = `${base}${path}`;

    const resp = await postJson(url, bodyForKushki, headers);

    // 7) Normalización de respuesta
    const okHttp = resp.status >= 200 && resp.status < 300;
    const data = resp.json || {};
    const externalId =
      data.id || data.payoutId || data.externalId || data.reference || null;

    const rawStatus =
      (data.status as string) || (okHttp ? "IN_TRANSIT" : "FAILED");

    const status = String(rawStatus).toUpperCase() as PayoutStatus;
    const paidAt = typeof data.paidAt === "string" ? data.paidAt : null;

    return res.status(okHttp ? 200 : 502).json({
      ok: okHttp,
      status,
      pspPayoutId: externalId,
      paidAt,
      error: okHttp ? null : (data.error || data.message || `HTTP ${resp.status}`),
      _debug: env.NODE_ENV === "development" ? { kushki: data } : undefined,
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || "Adapter error" });
  }
});

/**
 * GET /adapter/kushki/payouts/:externalId
 * Consulta estado del payout en Kushki y normaliza a { status, paidAt?, failureCode?, failureMessage? }.
 */
router.get("/payouts/:externalId", async (req: Request, res: Response) => {
  try {
    // 1) Autorización interna del adapter
    const auth = String(req.headers.authorization || "").trim();
    const expected = env.PAYOUTS_HTTP_APIKEY ? `Bearer ${env.PAYOUTS_HTTP_APIKEY}` : "";
    if (expected && auth !== expected) {
      return bad(res, 401, "Unauthorized (adapter key)");
    }

    const externalId = String(req.params.externalId || "").trim();
    if (!externalId) return bad(res, 400, "externalId requerido");

    const privId = env.KUSHKI_PRIVATE_MERCHANT_ID;
    if (!privId) return bad(res, 500, "KUSHKI_PRIVATE_MERCHANT_ID no configurado");

    const base = kushkiBaseUrl();
    const path = kushkiPayoutsStatusPath(externalId);
    const url = `${base}${path}`;

    const headers: Record<string, string> = {
      "Private-Merchant-Id": privId,
    };

    const resp = await getJson(url, headers);
    if (resp.status === 404) {
      return res.status(404).json({ ok: false, error: "No encontrado en PSP" });
    }
    if (!(resp.status >= 200 && resp.status < 300)) {
      return res.status(502).json({ ok: false, error: `HTTP ${resp.status}` });
    }

    const data = resp.json || {};
    const rawStatus = String(data.status ?? data.state ?? "").toUpperCase();
    const allowed: PayoutStatus[] = ["PENDING", "SCHEDULED", "IN_TRANSIT", "PAID", "FAILED", "CANCELED"];
    const status: PayoutStatus | undefined = allowed.includes(rawStatus as PayoutStatus)
      ? (rawStatus as PayoutStatus)
      : undefined;

    return res.json({
      ok: true,
      status: status ?? "IN_TRANSIT",
      paidAt: typeof data.paidAt === "string" ? data.paidAt : null,
      failureCode: data.failureCode ?? null,
      failureMessage: data.failureMessage ?? data.error ?? null,
      _debug: env.NODE_ENV === "development" ? { kushki: data } : undefined,
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || "Adapter status error" });
  }
});

/**
 * Variante por query: GET /adapter/kushki/payouts?externalId=...
 * Útil si tu reconciliador la usa.
 */
router.get("/payouts", async (req: Request, res: Response) => {
  const externalId = String(req.query.externalId || "").trim();
  if (!externalId) return bad(res, 400, "externalId requerido");
  // Reutilizamos la ruta de arriba
  (req as any).params = { externalId };
  return (router as any).handle(req, res); // delega al mismo router
});

/**
 * Webhook desde Kushki → actualiza Payouts (usa raw body para firma HMAC).
 * Monta este router antes de express.json global o usa express.raw en server.ts para /adapter/kushki/webhooks.
 */
router.post(
  "/webhooks",
  express.raw({ type: "*/*" }),
  async (req: Request, res: Response) => {
    try {
      const secret = (env.KUSHKI_WEBHOOK_SECRET || "").trim();
      const rawBody: Buffer = Buffer.isBuffer(req.body)
        ? (req.body as Buffer)
        : Buffer.from(String(req.body || ""), "utf8");

      if (secret) {
        const provided =
          (req.headers["x-kushki-signature"] as string) ||
          (req.headers["x-signature"] as string) ||
          "";
        if (!provided) return bad(res, 401, "Missing signature");
        const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
        if (!safeEq(digest, provided)) return bad(res, 401, "Invalid signature");
      }

      let body: any = {};
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return bad(res, 400, "Invalid JSON");
      }

      const externalId =
        body.id || body.payoutId || body.externalId || body.reference || null;

      const payoutIdRaw = body.metadata?.payoutId ?? body.payoutId ?? null;

      const rawStatus = String(body.status ?? body.state ?? "").toUpperCase();
      const allowed: PayoutStatus[] = [
        "PENDING",
        "SCHEDULED",
        "IN_TRANSIT",
        "PAID",
        "FAILED",
        "CANCELED",
      ];
      const status: PayoutStatus | undefined = allowed.includes(rawStatus as PayoutStatus)
        ? (rawStatus as PayoutStatus)
        : undefined;

      const paidAt = typeof body.paidAt === "string" ? new Date(body.paidAt) : null;
      const failureCode = body.failureCode ?? null;
      const failureMessage = body.failureMessage ?? body.error ?? null;

      let payout = null as Awaited<ReturnType<typeof prisma.payout.findFirst>> | null;

      if (externalId) {
        payout = await prisma.payout.findFirst({
          where: { pspPayoutId: String(externalId) },
        });
      }
      if (!payout && payoutIdRaw != null) {
        const pid = Number(payoutIdRaw);
        if (Number.isFinite(pid)) {
          payout = await prisma.payout.findUnique({ where: { id: pid } });
        }
      }

      if (!payout) {
        return res.status(202).json({ ok: true, ignored: true });
      }

      const data: any = { externalStatus: rawStatus || null };
      if (externalId && !payout.pspPayoutId) data.pspPayoutId = String(externalId);
      if (status) data.status = status;
      if (paidAt && status === "PAID") data.paidAt = paidAt;
      if (failureCode) data.failureCode = String(failureCode);
      if (failureMessage) data.failureMessage = String(failureMessage);

      await prisma.payout.update({ where: { id: payout.id }, data });

      return res.status(200).json({ ok: true });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err?.message || "Webhook adapter error" });
    }
  }
);

/**
 * Variante por query: GET /adapter/kushki/payouts?externalId=...
 * Evitamos recursion llamando el mismo flujo que /payouts/:externalId.
 */
router.get("/payouts", async (req: Request, res: Response) => {
  try {
    // 1) Autorización interna del adapter
    const auth = String(req.headers.authorization || "").trim();
    const expected = env.PAYOUTS_HTTP_APIKEY ? `Bearer ${env.PAYOUTS_HTTP_APIKEY}` : "";
    if (expected && auth !== expected) {
      return bad(res, 401, "Unauthorized (adapter key)");
    }

    const externalId = String(req.query.externalId || "").trim();
    if (!externalId) return bad(res, 400, "externalId requerido");

    const privId = env.KUSHKI_PRIVATE_MERCHANT_ID;
    if (!privId) return bad(res, 500, "KUSHKI_PRIVATE_MERCHANT_ID no configurado");

    const base = kushkiBaseUrl();
    const path = kushkiPayoutsStatusPath(externalId);
    const url = `${base}${path}`;

    const headers: Record<string, string> = {
      "Private-Merchant-Id": privId,
    };

    const resp = await getJson(url, headers);
    if (resp.status === 404) {
      return res.status(404).json({ ok: false, error: "No encontrado en PSP" });
    }
    if (!(resp.status >= 200 && resp.status < 300)) {
      return res.status(502).json({ ok: false, error: `HTTP ${resp.status}` });
    }

    const data = resp.json || {};
    const rawStatus = String(data.status ?? data.state ?? "").toUpperCase();
    const allowed = ["PENDING", "SCHEDULED", "IN_TRANSIT", "PAID", "FAILED", "CANCELED"] as const;
    const status = allowed.includes(rawStatus as any) ? (rawStatus as typeof allowed[number]) : "IN_TRANSIT";

    return res.json({
      ok: true,
      status,
      paidAt: typeof data.paidAt === "string" ? data.paidAt : null,
      failureCode: data.failureCode ?? null,
      failureMessage: data.failureMessage ?? data.error ?? null,
      _debug: env.NODE_ENV === "development" ? { kushki: data } : undefined,
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || "Adapter status error" });
  }
});


export default router;


