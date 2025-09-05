// src/routes/admin.payouts.routes.ts
import { Router, Request, Response } from "express";
import crypto from "crypto";
import prisma from "../prisma/client";
import { env } from "../config/env";
import { getPayoutProvider } from "../services/payouts/provider";
import { request as httpsRequest } from "https";
import { request as httpRequest } from "http";
import { URL } from "url";
import { runPayoutsRetryOnce } from "../jobs/payouts.retry.job";
import { runPayoutsReconcileOnce } from "../jobs/payouts.reconcile.job";
import {
  adminListPayouts,
  adminMarkPayoutPaid,
  adminRunPayoutsNow,
} from "../controllers/payments.controller";
import { authenticateToken, requireSuperadmin } from "../middleware/authMiddleware";

const router = Router();

// Aplica auth + superadmin a todo el router
router.use(authenticateToken, requireSuperadmin);

type PayoutStatus =
  | "PENDING"
  | "SCHEDULED"
  | "IN_TRANSIT"
  | "PAID"
  | "FAILED"
  | "CANCELED";

/* ====================== helpers ====================== */

function newIdempotencyKey(prefix = "payout") {
  try {
    return `${prefix}_${crypto.randomUUID()}`;
  } catch {
    return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
  }
}

function assertAccountReady(acc: {
  payoutsEnabled: boolean;
  payoutBankName: string | null;
  payoutAccountType: any | null;
  payoutAccountNumber: string | null;
  payoutHolderName: string | null;
  payoutHolderRut: string | null;
}) {
  if (!acc.payoutsEnabled) throw new Error("La cuenta del organizador no tiene payouts habilitados.");
  if (!acc.payoutHolderName || !acc.payoutHolderRut) throw new Error("Titular/RUT del destinatario incompleto.");
  if (!acc.payoutBankName || !acc.payoutAccountNumber || !acc.payoutAccountType)
    throw new Error("Datos bancarios incompletos (banco/tipo/número).");
}

function pickReq(url: URL) {
  return url.protocol === "http:" ? httpRequest : httpsRequest;
}

/** GET JSON simple (para reconciliación con el adapter si soporta status) */
function getJson(urlStr: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; json: any; raw: string }>((resolve, reject) => {
    try {
      const url = new URL(urlStr);
      const reqFn = pickReq(url);
      const opts = {
        method: "GET",
        hostname: url.hostname,
        port: url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443,
        path: url.pathname + (url.search || ""),
        headers,
      };

      const req = reqFn(opts, (res) => {
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

function normalizeStatus(s: any): PayoutStatus | undefined {
  const x = String(s ?? "").toUpperCase();
  const allowed: PayoutStatus[] = ["PENDING", "SCHEDULED", "IN_TRANSIT", "PAID", "FAILED", "CANCELED"];
  return allowed.includes(x as PayoutStatus) ? (x as PayoutStatus) : undefined;
}

/* ====================== Rutas ADMIN ====================== */

/**
 * GET /api/admin/payouts
 * Listado admin de payouts (usa el controlador existente).
 */
router.get("/", adminListPayouts);

/**
 * POST /api/admin/payouts/:id/mark-paid
 * Marcar payout como pagado (simulación).
 */
router.post("/:id/mark-paid", adminMarkPayoutPaid);

/**
 * POST /api/admin/payouts/run
 * Ejecutar batch de pagos ahora (sim/http según PAYOUTS_DRIVER).
 */
router.post("/run", adminRunPayoutsNow);

/**
 * POST /api/admin/payouts/:id/retry
 * Fuerza un reintento idempotente del payout.
 */
router.post("/:id/retry", async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

    const payout = await prisma.payout.findUnique({
      where: { id },
      include: { account: true },
    });
    if (!payout) return res.status(404).json({ error: "Payout no encontrado" });

    if (!payout.account) return res.status(409).json({ error: "Cuenta destino no encontrada" });
    try {
      assertAccountReady(payout.account);
    } catch (e: any) {
      return res.status(409).json({ error: e?.message || "Cuenta destino no lista para payouts" });
    }

    if (payout.status === "PAID") {
      return res.status(409).json({ error: "El payout ya está en estado PAID" });
    }
    // Permitimos reintento incluso si IN_TRANSIT/SCHEDULED (replay idempotente)

    // Asegurar idempotencyKey
    const idem = payout.idempotencyKey || newIdempotencyKey();
    if (!payout.idempotencyKey) {
      await prisma.payout.update({ where: { id: payout.id }, data: { idempotencyKey: idem } });
    }

    const provider = getPayoutProvider();
    const resp = await provider.pay({
      payoutId: payout.id,
      amount: payout.amount,
      currency: payout.currency || "CLP",
      account: {
        bankName: payout.account.payoutBankName || undefined,
        accountType: (payout.account.payoutAccountType as any) || undefined,
        accountNumber: payout.account.payoutAccountNumber || undefined,
        holderName: payout.account.payoutHolderName || undefined,
        holderRut: payout.account.payoutHolderRut || undefined,
      },
      idempotencyKey: idem,
    });

    // Persistir cambios
    const data: any = {
      retries: resp.ok ? payout.retries : (payout.retries || 0) + 1,
    };
    if (resp.status) {
      data.status = resp.status;
      data.externalStatus = resp.status;
    } else if (resp.ok) {
      data.status = "IN_TRANSIT";
      data.externalStatus = "IN_TRANSIT";
    }
    if (resp.pspPayoutId && !payout.pspPayoutId) data.pspPayoutId = resp.pspPayoutId;
    if (resp.paidAt && (!payout.paidAt || data.status === "PAID")) data.paidAt = new Date(resp.paidAt);
    if (!resp.ok && resp.error) data.failureMessage = String(resp.error).slice(0, 255);

    const updated = await prisma.payout.update({ where: { id: payout.id }, data });

    return res.json({
      ok: !!resp.ok,
      payout: updated,
      message: resp.ok ? "Reintentado correctamente" : resp.error || "Fallo en el reintento",
    });
  } catch (err: any) {
    console.error("admin.payouts.retry error:", err);
    return res.status(500).json({ error: err?.message || "Error reintentando payout" });
  }
});

/**
 * POST /api/admin/payouts/reconcile
 * Revisa payouts en estado SCHEDULED/IN_TRANSIT y consulta estado al adapter (si soporta GET /payouts/:externalId).
 * Body opcional: { limit?: number }
 */
router.post("/reconcile", async (req: Request, res: Response) => {
  try {
    const limit = Math.max(1, Math.min(200, Number((req.body as any)?.limit ?? 100)));

    const baseUrl = String(env.PAYOUTS_HTTP_BASEURL || "").trim().replace(/\/+$/, "");
    const apiKey = String(env.PAYOUTS_HTTP_APIKEY || "").trim();
    if (!baseUrl) {
      return res.status(501).json({ error: "Adapter HTTP no configurado (PAYOUTS_HTTP_BASEURL vacío)" });
    }

    const pending = await prisma.payout.findMany({
      where: { status: { in: ["SCHEDULED", "IN_TRANSIT"] } },
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: { id: true, pspPayoutId: true },
    });

    if (!pending.length) return res.json({ ok: true, scanned: 0, updated: 0 });

    let updated = 0;
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    for (const p of pending) {
      if (!p.pspPayoutId) continue;

      // Intento 1: GET /payouts/:externalId
      const urlV1 = `${baseUrl}/payouts/${encodeURIComponent(p.pspPayoutId)}`;
      let resp = await getJson(urlV1, headers);

      if (resp.status === 404) {
        // Intento 2 (query): GET /payouts?externalId=...
        const urlV2 = `${baseUrl}/payouts?externalId=${encodeURIComponent(p.pspPayoutId)}`;
        try {
          const r2 = await getJson(urlV2, headers);
          if (r2.status >= 200 && r2.status < 300) {
            resp = r2;
          }
        } catch {
          // ignorar
          /* noop */
        }
      }

      if (!(resp.status >= 200 && resp.status < 300)) {
        continue;
      }

      const body = resp.json || {};
      const st = normalizeStatus(body.status);
      const patch: any = { externalStatus: body.status || null };
      if (st) patch.status = st;
      if (body.paidAt) patch.paidAt = new Date(body.paidAt);
      if (body.failureCode) patch.failureCode = String(body.failureCode);
      if (body.failureMessage) patch.failureMessage = String(body.failureMessage);

      await prisma.payout.update({ where: { id: p.id }, data: patch });
      updated++;
    }

    return res.json({ ok: true, scanned: pending.length, updated });
  } catch (err: any) {
    console.error("admin.payouts.reconcile error:", err);
    return res.status(500).json({ error: err?.message || "Error en reconciliación" });
  }
});

/**
 * POST /api/admin/payouts/run-retry
 * Ejecuta una corrida manual del job de reintentos (útil desde panel admin).
 * Body opcional: { limit?: number }
 */
router.post("/run-retry", async (req: Request, res: Response) => {
  try {
    const limit = Number((req.body as any)?.limit);
    const result = await runPayoutsRetryOnce(Number.isFinite(limit) ? limit : undefined);
    return res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("admin.payouts.run-retry error:", err);
    return res.status(500).json({ error: err?.message || "Error ejecutando job de reintentos" });
  }
});

/**
 * POST /api/admin/payouts/run-reconcile
 * Ejecuta una corrida manual del job de reconciliación (útil desde panel admin).
 * Body opcional: { limit?: number }
 */
router.post("/run-reconcile", async (req: Request, res: Response) => {
  try {
    const limit = Number((req.body as any)?.limit);
    const result = await runPayoutsReconcileOnce(Number.isFinite(limit) ? limit : undefined);
    return res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("admin.payouts.run-reconcile error:", err);
    return res.status(500).json({ error: err?.message || "Error ejecutando job de reconciliación" });
  }
});

export default router;


