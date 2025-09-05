// src/routes/psp.routes.ts
import express, { Router, Request, Response } from "express";
import prisma from "../prisma/client";
import { env } from "../config/env";
import { getPspProvider } from "../services/psp/provider";

const router = Router();
const psp = getPspProvider();

/* ================================
   Helpers
   ================================ */

function toInt(v: unknown, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : def;
}
function nowISO() {
  return new Date().toISOString();
}
function ok(res: Response, data: any = { ok: true }) {
  return res.status(200).json(data);
}
function bad(res: Response, msg = "Bad Request", code = 400) {
  return res.status(code).json({ ok: false, error: msg });
}
function pick(obj: any, keys: string[]) {
  const out: any = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/* =========================================================
   Onboarding de vendedores (conectar cuenta en el PSP)
   ========================================================= */

/**
 * Inicia el onboarding del vendedor.
 * Usa req.user.id si tu middleware de auth lo agrega; si no, acepta body.userId.
 *
 * Body (opcional):
 * - userId?: number (fallback si no hay sesión)
 * - redirectUri?: string (si quieres sobreescribir el callback)
 */
router.post("/connect/start", async (req: Request, res: Response) => {
  try {
    const userId =
      (req as any)?.user?.id ??
      toInt(req.body?.userId, 0);

    if (!userId) return bad(res, "userId requerido o sesión no presente");

    const redirectUri =
      String(req.body?.redirectUri ?? env.MP_REDIRECT_URI ?? `${env.BACKEND_URL}/api/psp/connect/callback`);

    const r = await psp.startOnboarding({
      userId,
      redirectUri,
      successUrl: env.PSP_CONNECT_SUCCESS_URL,
      failureUrl: env.PSP_CONNECT_FAILURE_URL,
    });

    if (!r.ok || !r.connectUrl) {
      return bad(res, r.error ?? "No se pudo iniciar el onboarding");
    }

    return ok(res, { ok: true, connectUrl: r.connectUrl });
  } catch (err: any) {
    return bad(res, err?.message ?? "Error iniciando onboarding", 500);
  }
});

/**
 * Callback del PSP tras el onboarding.
 * Debes configurar el PSP para que apunte a esta URL.
 *
 * Recomendación: incluir un parámetro `state=<userId>` en la URL de conexión
 * para saber a qué usuario pertenece la cuenta que se está conectando.
 */
router.all("/connect/callback", async (req: Request, res: Response) => {
  try {
    const stateUserId =
      toInt((req.query?.state as any) ?? (req.body?.state as any), 0);

    const parsed = await psp.parseOnboardingCallback({
      payload: { ...req.query, ...req.body },
    });

    if (!parsed.ok || !parsed.pspAccountId) {
      const url = env.PSP_CONNECT_FAILURE_URL;
      if (url) return res.redirect(url);
      return bad(res, parsed.error ?? "Onboarding no completado");
    }

    if (!stateUserId) {
      // Si no viene user en state, no sabemos a quién asociar
      const url = env.PSP_CONNECT_FAILURE_URL;
      if (url) return res.redirect(url);
      return bad(res, "Falta parámetro state con userId");
    }

    // Upsert de ConnectedAccount
    await prisma.connectedAccount.upsert({
      where: { userId: stateUserId },
      create: {
        userId: stateUserId,
        psp: String(env.PSP_PROVIDER ?? "MP"),
        pspAccountId: parsed.pspAccountId,
        payoutsEnabled: !!parsed.payoutsEnabled,
        onboardingStatus: (parsed.onboardingStatus as any) ?? "COMPLETE",
      },
      update: {
        psp: String(env.PSP_PROVIDER ?? "MP"),
        pspAccountId: parsed.pspAccountId,
        payoutsEnabled: !!parsed.payoutsEnabled,
        onboardingStatus: (parsed.onboardingStatus as any) ?? "COMPLETE",
      },
    });

    const url = env.PSP_CONNECT_SUCCESS_URL;
    if (url) return res.redirect(url);
    return ok(res, { ok: true });
  } catch (err: any) {
    const url = env.PSP_CONNECT_FAILURE_URL;
    if (url) return res.redirect(url);
    return bad(res, err?.message ?? "Error en callback", 500);
  }
});

/* =========================================================
   Webhook del PSP (pagos, cuentas, payouts)
   =========================================================
   IMPORTANTE: este endpoint necesita el cuerpo RAW para verificar la firma.
   Monta esta ruta ANTES del express.json() global, o usa el raw middleware
   a nivel de ruta como se hace aquí.
*/
router.post(
  "/webhook",
  express.raw({ type: "*/*" }),
  async (req: Request, res: Response) => {
    try {
      const rawBody = req.body as Buffer;

      // Verificación de firma
      const okSig = psp.verifyWebhookSignature(rawBody, req.headers as any);
      if (!okSig) return bad(res, "Firma inválida", 401);

      // Intentar parsear JSON
      let parsed: any = undefined;
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        // Algunos PSP envían x-www-form-urlencoded; podrías parsearlo aquí si aplica
        parsed = undefined;
      }

      const events = psp.parseWebhook(parsed);
      if (!events) return ok(res); // nothing to do

      const list = Array.isArray(events) ? events : [events];
      const results: any[] = [];

      for (const evt of list) {
        try {
          switch (evt.type) {
            case "payment.updated": {
              const d = evt.data;

              // Buscar el Payment por pspPaymentId
              const payment = await prisma.payment.findFirst({
                where: { pspPaymentId: d.pspPaymentId },
                select: { id: true, reservationId: true, status: true },
              });

              if (!payment) {
                results.push({ type: evt.type, skipped: true, reason: "payment not found" });
                break;
              }

              // Preparar actualización
              const updateData: any = {
                status: d.status as any,
                escrowStatus: d.escrowStatus as any,
                authorizedAmount: d.authorizedAmount ?? undefined,
                capturedAmount: d.capturedAmount ?? undefined,
                refundedAmount: d.refundedAmount ?? undefined,
                pspMetadata: { ...(d.metadata ?? {}), whReceivedAt: nowISO() },
              };

              // Si pasó a CAPTURED, podemos sellar capturedAt
              if (d.status === "CAPTURED") {
                updateData.capturedAt = new Date(d.occurredAt ?? Date.now());
              }

              // Aplicar actualización del Payment
              await prisma.payment.update({
                where: { id: payment.id },
                data: updateData,
              });

              // Si CAPTURED → marcar reserva como pagada
              if (d.status === "CAPTURED" && payment.reservationId) {
                await prisma.reservation.update({
                  where: { id: payment.reservationId },
                  data: {
                    status: "PAID",
                    paidAt: new Date(d.occurredAt ?? Date.now()),
                  },
                });
              }

              results.push({ type: evt.type, paymentId: payment.id, updated: true });
              break;
            }

            case "account.updated": {
              const d = evt.data;

              const acc = await prisma.connectedAccount.findFirst({
                where: { pspAccountId: d.pspAccountId },
                select: { id: true },
              });

              if (!acc) {
                results.push({ type: evt.type, skipped: true, reason: "account not found" });
                break;
              }

              await prisma.connectedAccount.update({
                where: { id: acc.id },
                data: {
                  payoutsEnabled: !!d.payoutsEnabled,
                  onboardingStatus: d.onboardingStatus as any,
                },
              });

              results.push({ type: evt.type, accountId: acc.id, updated: true });
              break;
            }

            case "payout.updated": {
              const d = evt.data;

              const payout = await prisma.payout.findFirst({
                where: { pspPayoutId: d.pspPayoutId },
                select: { id: true },
              });

              if (!payout) {
                results.push({ type: evt.type, skipped: true, reason: "payout not found" });
                break;
              }

              await prisma.payout.update({
                where: { id: payout.id },
                data: {
                  status: (d.status as any) ?? undefined,
                  failureCode: d.failureCode ?? undefined,
                  failureMessage: d.failureMessage ?? undefined,
                },
              });

              results.push({ type: evt.type, payoutId: payout.id, updated: true });
              break;
            }

            default:
              results.push({ type: (evt as any)?.type ?? "unknown", skipped: true });
              break;
          }
        } catch (e: any) {
          results.push({ type: (evt as any)?.type, error: e?.message ?? "handler error" });
        }
      }

      return ok(res, { ok: true, results });
    } catch (err: any) {
      return bad(res, err?.message ?? "Webhook error", 500);
    }
  }
);

/* =========================================================
   Utilidad opcional: consultar estado de cuenta conectada
   ========================================================= */
/**
 * GET /api/psp/account/:pspAccountId/status
 * (útil para revalidar desde el panel admin)
 */
router.get("/account/:pspAccountId/status", async (req: Request, res: Response) => {
  try {
    const pspAccountId = String(req.params.pspAccountId);
    const r = await psp.getAccountStatus({ pspAccountId });
    if (!r.ok) return bad(res, r.error ?? "No disponible");
    return ok(res, r);
  } catch (err: any) {
    return bad(res, err?.message ?? "Error consultando cuenta", 500);
  }
});

export default router;

/* =========================================================
   Cómo montarlo en server.ts (referencia):
   ---------------------------------------------------------
   import pspRoutes from "./routes/psp.routes";
   // Importante: NO usar express.json() antes del webhook sin aislarlo.
   app.use("/api/psp", pspRoutes); // el raw del webhook está a nivel de ruta
   ========================================================= */
