// src/jobs/payouts.reconcile.job.ts
import prisma from "../prisma/client";
import { env } from "../config/env";
import { request as httpsRequest } from "https";
import { request as httpRequest } from "http";
import { URL } from "url";

type PayoutStatus = "PENDING" | "SCHEDULED" | "IN_TRANSIT" | "PAID" | "FAILED" | "CANCELED";

/* ================= helpers ================= */

function pickReq(url: URL) {
  return url.protocol === "http:" ? httpRequest : httpsRequest;
}

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

/* =============== lógica de una corrida =============== */
export async function runPayoutsReconcileOnce(limitArg?: number) {
  const baseUrl = String(env.PAYOUTS_HTTP_BASEURL || "").trim().replace(/\/+$/, "");
  const apiKey = String(env.PAYOUTS_HTTP_APIKEY || "").trim();

  if (!baseUrl) {
    console.warn("[reconcile] PAYOUTS_HTTP_BASEURL vacío — omitiendo corrida");
    return { scanned: 0, updated: 0, skipped: 0 };
  }

  const limitFromEnv = Number(env.PAYOUTS_RECONCILE_LIMIT || 200);
  const limit = Math.max(1, Math.min(500, Number(limitArg ?? limitFromEnv)));

  const pending = await prisma.payout.findMany({
    where: { status: { in: ["SCHEDULED", "IN_TRANSIT"] } },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { id: true, pspPayoutId: true },
  });

  if (!pending.length) {
    return { scanned: 0, updated: 0, skipped: 0 };
  }

  let updated = 0;
  let skipped = 0;

  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  for (const p of pending) {
    if (!p.pspPayoutId) {
      skipped++;
      continue;
    }

    try {
      // Intento principal: /payouts/:externalId
      let resp = await getJson(`${baseUrl}/payouts/${encodeURIComponent(p.pspPayoutId)}`, headers);

      // Fallback opcional si el adapter soporta query (?externalId=)
      if (resp.status === 404) {
        try {
          const r2 = await getJson(`${baseUrl}/payouts?externalId=${encodeURIComponent(p.pspPayoutId)}`, headers);
          if (r2.status >= 200 && r2.status < 300) resp = r2;
        } catch {
          // ignorar
        }
      }

      if (!(resp.status >= 200 && resp.status < 300)) {
        skipped++;
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
    } catch {
      skipped++;
      continue;
    }
  }

  return { scanned: pending.length, updated, skipped };
}

/* ================= scheduler ================= */
export function startPayoutsReconcileJob() {
  const enabled = !!env.PAYOUTS_RECONCILE_JOB_ENABLED;
  if (!enabled) {
    console.log("[reconcile] Job deshabilitado por env PAYOUTS_RECONCILE_JOB_ENABLED");
    return;
  }

  const intervalMin = Math.max(1, Number(env.PAYOUTS_RECONCILE_INTERVAL_MINUTES || 30));
  const intervalMs = intervalMin * 60 * 1000;

  let running = false;

  const tick = async () => {
    if (running) {
      console.log("[reconcile] corrida anterior aún en curso — se salta ciclo");
      return;
    }
    running = true;
    const t0 = Date.now();
    try {
      const res = await runPayoutsReconcileOnce();
      const dt = Date.now() - t0;
      console.log(`[reconcile] ok scanned=${res.scanned} updated=${res.updated} skipped=${res.skipped} in ${dt}ms`);
    } catch (err) {
      console.error("[reconcile] error:", err);
    } finally {
      running = false;
    }
  };

  const jitter = 2000 + Math.floor(Math.random() * 6000);
  setTimeout(() => {
    tick();
    setInterval(tick, intervalMs);
  }, jitter);

  console.log(`[reconcile] Job iniciado: cada ${intervalMin} minutos`);
}


