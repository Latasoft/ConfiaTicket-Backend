// src/jobs/payouts.retry.job.ts
import prisma from "../prisma/client";
import { getPayoutProvider } from "../services/payouts/provider";
import { generateIdempotencyKey } from "../services/payment.service";
import { env } from "../config/env";
import crypto from "crypto";
import { request as httpsRequest } from "https";
import { URL } from "url";

/**
 * Job de reintentos con backoff para payouts fallidos o pendientes.
 * - Reintenta PENDING / FAILED usando idempotencia.
 * - Respeta un schedule de backoff configurable por env.
 * - Alcanza un máximo de reintentos y luego deja de insistir.
 * - Opcional: alerta por Slack cuando alcanza el máximo.
 */

type PayoutStatus =
  | "PENDING"
  | "SCHEDULED"
  | "IN_TRANSIT"
  | "PAID"
  | "FAILED"
  | "CANCELED";

/* ================= helpers ================= */

/** Parseo del schedule desde env: "60,300,1800,10800,86400" (segundos) */
function parseSchedule(s?: string | null): number[] {
  if (!s) return [];
  return String(s)
    .split(",")
    .map((x) => Math.max(1, Number(x.trim() || "0")))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** Default (segundos): 1m, 5m, 30m, 3h, 24h */
const DEFAULT_SCHEDULE: number[] = [60, 300, 1800, 10800, 86400];

/** Delay en ms según # de reintentos (con fallback seguro) */
function delayForRetries(retries: number, schedule?: number[] | null): number {
  const arr = (schedule && schedule.length ? schedule : DEFAULT_SCHEDULE) as number[];
  if (!arr.length) return 60_000;
  const lastIndex = Math.max(0, Math.min(retries, arr.length - 1));
  const seconds = arr[lastIndex] ?? arr[arr.length - 1] ?? 60;
  return seconds * 1000;
}

/** Validación mínima de datos bancarios del destinatario */
function assertAccountReady(acc: {
  payoutsEnabled: boolean;
  payoutBankName: string | null;
  payoutAccountType: any | null;
  payoutAccountNumber: string | null;
  payoutHolderName: string | null;
  payoutHolderRut: string | null;
}) {
  if (!acc.payoutsEnabled) throw new Error("Payouts deshabilitados para la cuenta destino.");
  if (!acc.payoutHolderName || !acc.payoutHolderRut) throw new Error("Titular/RUT incompletos.");
  if (!acc.payoutBankName || !acc.payoutAccountNumber || !acc.payoutAccountType)
    throw new Error("Datos bancarios incompletos (banco/tipo/número).");
}

/** Slack webhook sin fetch (https nativo) */
async function postSlack(text: string) {
  const urlStr = (process.env.SLACK_WEBHOOK_URL || "").trim();
  if (!urlStr) return;

  try {
    const url = new URL(urlStr);
    const body = Buffer.from(JSON.stringify({ text }), "utf8");
    const opts = {
      method: "POST",
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 443,
      path: url.pathname + (url.search || ""),
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
      },
    };
    await new Promise<void>((resolve, reject) => {
      const req = httpsRequest(opts, (res) => {
        res.on("data", () => {});
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.warn("[payouts-retry] Slack webhook error:", (err as any)?.message);
  }
}

/* =============== corrida única =============== */
export async function runPayoutsRetryOnce(limitArg?: number) {
  const maxRetries = Math.max(0, Number(env.PAYOUTS_MAX_RETRIES ?? 5));
  const limitEnv = Math.max(1, Number(env.PAYOUTS_RETRY_LIMIT ?? 50));
  const limit = Math.max(1, Math.min(500, Number(limitArg ?? limitEnv)));
  const schedule = parseSchedule(env.PAYOUTS_RETRY_SCHEDULE);

  // Candidatos: PENDING / FAILED que no exceden maxRetries
  const candidates = await prisma.payout.findMany({
    where: { status: { in: ["PENDING", "FAILED"] }, retries: { lt: maxRetries } },
    orderBy: { updatedAt: "asc" },
    take: limit * 3, // traemos más y filtramos por backoff
    include: { account: true },
  });

  const nowMs = Date.now();
  const eligible = candidates
    .filter((p) => {
      const ms = delayForRetries(p.retries ?? 0, schedule);
      const last = new Date(p.updatedAt).getTime();
      return nowMs - last >= ms;
    })
    .slice(0, limit);

  if (!eligible.length) {
    return { scanned: candidates.length, retried: 0, skipped: candidates.length };
  }

  const provider = getPayoutProvider();

  let retried = 0;
  for (const p of eligible) {
    try {
      if (!p.account) {
        await prisma.payout.update({
          where: { id: p.id },
          data: {
            retries: (p.retries ?? 0) + 1,
            failureMessage: "Payout sin cuenta destino asociada",
          },
        });
        continue;
      }

      // Validaciones mínimas de la cuenta (evitar llamadas inútiles al PSP)
      try {
        assertAccountReady(p.account);
      } catch (e: any) {
        await prisma.payout.update({
          where: { id: p.id },
          data: {
            retries: (p.retries ?? 0) + 1,
            failureMessage: `Cuenta no lista: ${String(e?.message || "datos incompletos")}`.slice(0, 255),
          },
        });
        continue;
      }

      // idempotencyKey obligatorio
      const idem = p.idempotencyKey?.trim() ? p.idempotencyKey : generateIdempotencyKey();
      if (!p.idempotencyKey) {
        await prisma.payout.update({ where: { id: p.id }, data: { idempotencyKey: idem } });
      }

      const resp = await provider.pay({
        payoutId: p.id,
        amount: p.amount,
        currency: p.currency || "CLP",
        account: {
          bankName: p.account.payoutBankName || undefined,
          accountType: (p.account.payoutAccountType as any) || undefined,
          accountNumber: p.account.payoutAccountNumber || undefined,
          holderName: p.account.payoutHolderName || undefined,
          holderRut: p.account.payoutHolderRut || undefined,
        },
        idempotencyKey: idem,
      });

      const patch: any = {
        retries: resp.ok ? p.retries : (p.retries ?? 0) + 1,
      };
      if (resp.status) {
        patch.status = resp.status as PayoutStatus;
        patch.externalStatus = resp.status;
      } else if (resp.ok) {
        patch.status = "IN_TRANSIT" as PayoutStatus;
        patch.externalStatus = "IN_TRANSIT";
      }
      if (resp.pspPayoutId && !p.pspPayoutId) patch.pspPayoutId = resp.pspPayoutId;
      if (resp.paidAt && (resp.status === "PAID" || !p.paidAt)) patch.paidAt = new Date(resp.paidAt);
      if (!resp.ok && resp.error) patch.failureMessage = String(resp.error).slice(0, 255);

      await prisma.payout.update({ where: { id: p.id }, data: patch });

      if (!resp.ok && (p.retries + 1) >= maxRetries) {
        void postSlack(
          `:warning: Payout ${p.id} alcanzó el máximo de reintentos (${maxRetries}). Estado actual: ${
            patch.status ?? p.status
          }.`
        );
      }

      retried++;
    } catch (err) {
      await prisma.payout.update({
        where: { id: p.id },
        data: {
          retries: (p.retries ?? 0) + 1,
          failureMessage: `Retry job error: ${(err as any)?.message || "unknown"}`.slice(0, 255),
        },
      });
    }
  }

  return { scanned: candidates.length, retried, skipped: candidates.length - eligible.length };
}

/* =============== scheduler =============== */
export function startPayoutsRetryJob() {
  const enabled = !!env.PAYOUTS_RETRY_JOB_ENABLED;
  if (!enabled) {
    console.log("[payouts-retry] Job deshabilitado por env PAYOUTS_RETRY_JOB_ENABLED");
    return;
  }

  const intervalMin = Math.max(1, Number(env.PAYOUTS_RETRY_INTERVAL_MINUTES ?? 5));
  const intervalMs = intervalMin * 60 * 1000;

  let running = false;

  const tick = async () => {
    if (running) {
      console.log("[payouts-retry] corrida anterior aún en curso — se salta ciclo");
      return;
    }
    running = true;
    const t0 = Date.now();
    try {
      const res = await runPayoutsRetryOnce();
      const dt = Date.now() - t0;
      console.log(
        `[payouts-retry] ok scanned=${res.scanned} retried=${res.retried} skipped=${res.skipped} in ${dt}ms`
      );
    } catch (err) {
      console.error("[payouts-retry] error:", err);
    } finally {
      running = false;
    }
  };

  const jitter = 2000 + Math.floor(Math.random() * 6000);
  setTimeout(() => {
    tick();
    setInterval(tick, intervalMs);
  }, jitter);

  console.log(`[payouts-retry] Job iniciado: cada ${intervalMin} minutos`);
}



