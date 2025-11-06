// src/controllers/tickets.controller.ts
/**
 * ⚠️ CONTROLLER LEGACY - SOLO LECTURA
 * 
 * Este controller maneja el flujo ANTIGUO donde los COMPRADORES
 * subían manualmente los tickets después de la compra.
 * 
 * ❌ NO CREAR NUEVAS RESERVAS CON ESTE FLUJO
 * 
 * NUEVO FLUJO (desde ticketGeneration.service.ts):
 * - OWN Events: Genera PDFs automáticamente usando GeneratedTicket model
 * - RESALE Events: Usa tickets pre-cargados por el organizador (Ticket model)
 * 
 * Este archivo se mantiene SOLO para:
 * 1. Leer/descargar tickets de reservas antiguas
 * 2. Procesar uploads pendientes (hasta que migren)
 * 3. Compatibilidad con datos históricos
 * 
 * TODO: Migrar reservas antiguas a nuevo flujo y eliminar este controller
 */
import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import prisma from "../prisma/client";
import { sha256, guessMimeByExt, safeStatSize, fileExists } from "../utils/file.utils";
import { addHours, isExpired, now } from "../utils/date.utils";

// ⬇️ PSP (Webpay) para capturar en aprobación
import { env } from "../config/env";
import {
  captureWebpayPayment,
  getWebpayStatus,
} from "../services/payment.service";

// ⬇️ Payouts
import { getPayoutProvider } from "../services/payouts/provider";
import {
  createPayout,
  calculateOrganizerNetAmount,
  assertAccountReady,
} from "../services/payout.service";

const DEADLINE_HOURS = Number(env.TICKET_UPLOAD_DEADLINE_HOURS ?? 24);

/* ====================== helpers de rol ====================== */
function isSuperadmin(req: Request) {
  return (req as any).user?.role === "superadmin";
}
function isOrganizer(req: Request) {
  return (req as any).user?.role === "organizer";
}
function isBuyer(req: Request) {
  return (req as any).user?.role === "buyer";
}

/* ====================== helpers de plazos ====================== */
function computeDeadline(paidAt?: Date | null, createdAt?: Date | null) {
  const base = paidAt ?? createdAt ?? new Date();
  return addHours(base, DEADLINE_HOURS);
}
function nowIsAfter(d?: Date | null) {
  return isExpired(d);
}

/* ==========================================================
 *  Reembolsos (STUB): reemplazar por PSP real
 * ==========================================================*/
async function refundPayment(payment: { id: number; amount: number; buyOrder: string }) {
  // TODO: integra con tu PSP (Webpay/Transbank: refund; Stripe: refunds.create, etc.)
  // Simulamos éxito y devolvemos un id de reembolso:
  return { id: `rf_${payment.id}_${Date.now()}`, amount: payment.amount };
}

/* ====================== helpers de payouts ====================== */

/** Dispara el payout llamando al provider y actualiza la fila */
async function triggerPayout(payoutId: number) {
  const payout = await prisma.payout.findUnique({
    where: { id: payoutId },
    include: {
      account: true,
    },
  });
  if (!payout) throw new Error("Payout no encontrado");

  const acc = payout.account;
  if (!acc) throw new Error("Cuenta destino no encontrada");
  assertAccountReady(acc);

  const provider = getPayoutProvider();

  const resp = await provider.pay({
    payoutId: payout.id,
    amount: payout.amount,
    currency: payout.currency || "CLP",
    account: {
      bankName: acc.payoutBankName || undefined,
      accountType: (acc.payoutAccountType as any) || undefined, // "VISTA" | "CORRIENTE" | "AHORRO" | "RUT"
      accountNumber: acc.payoutAccountNumber || undefined,
      holderName: acc.payoutHolderName || undefined,
      holderRut: acc.payoutHolderRut || undefined,
    },
    idempotencyKey: payout.idempotencyKey,
    requestId: `payout:${payout.id}`,
  });

  // Normalización y guardado
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
  if (resp.paidAt && (!payout.paidAt || data.status === "PAID")) {
    data.paidAt = new Date(resp.paidAt);
  }
  if (!resp.ok && resp.error) {
    data.failureMessage = resp.error.slice(0, 255);
  }

  await prisma.payout.update({
    where: { id: payout.id },
    data,
  });

  return resp;
}

/* ============================================================
 *  Helpers comunes (detalle y mapeos)
 * ==========================================================*/
function mapTbkStatusToLocal(s?: string | null) {
  const u = String(s || "").toUpperCase();
  if (u === "AUTHORIZED") return "AUTHORIZED";
  if (u === "FAILED") return "FAILED";
  if (u === "REVERSED" || u === "NULLIFIED") return "VOIDED";
  if (u === "COMMITTED" || u === "PAYMENT_COMMITTED") return "COMMITTED";
  return null;
}

function ensureBuyerOrAdmin(reservation: { buyerId: number }, req: Request) {
  if (isSuperadmin(req)) return true;
  const userId = (req as any).user?.id;
  if (!userId) return false;
  return reservation.buyerId === userId;
}

function buildReservationDetail(r: any) {
  const ticketSize = safeStatSize(r.ticketFilePath);
  return {
    // TicketFlowStatus core
    id: r.id,
    status: r.status,
    fulfillmentStatus: r.fulfillmentStatus,
    ticketUploadedAt: r.ticketUploadedAt,
    approvedAt: r.approvedAt,
    deliveredAt: r.deliveredAt,
    rejectionReason: r.rejectionReason,
    ticketUploadDeadlineAt: r.ticketUploadDeadlineAt,
    refundStatus: r.refundStatus,
    refundedAt: r.refundedAt,

    // Detalle adicional
    reservationId: r.id,
    createdAt: r.createdAt,
    quantity: r.quantity,
    amount: r.amount,
    event: r.event
      ? {
          id: r.event.id,
          title: r.event.title,
          date: r.event.date,
          venue: r.event.location ?? null,
          city: r.event.location ?? null, // si tienes event.city propio, cambia esto
          coverImageUrl: r.event.coverImageUrl ?? null,
        }
      : null,

    ticketFileName: r.ticketFileName ?? null,
    ticketMime: r.ticketMime ?? (r.ticketFilePath ? guessMimeByExt(r.ticketFilePath) : null),
    ticketSize,

    payment: r.payment
      ? {
          id: r.payment.id,
          status: r.payment.status,
          isDeferredCapture: !!r.payment.isDeferredCapture,
          capturePolicy: r.payment.capturePolicy,
          escrowStatus: r.payment.escrowStatus,
          token: r.payment.token,
          buyOrder: r.payment.buyOrder,
          authorizedAmount: r.payment.authorizedAmount ?? null,
          capturedAmount: r.payment.capturedAmount ?? null,
          updatedAt: r.payment.updatedAt,
        }
      : null,
  };
}

/* ============================================================
 *  ORGANIZER: LISTAR RESERVAS (para tabla en misma página)
 * ==========================================================*/
export async function organizerListReservations(req: Request, res: Response) {
  try {
    if (!isOrganizer(req) && !isSuperadmin(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const organizerId = (req as any).user?.id as number | undefined;

    const q = String(req.query?.q ?? "").trim();

    // Normalizamos el status recibido desde el front:
    const rawStatus = String(req.query?.status ?? "").trim().toUpperCase();
    const VALID = new Set(["PAID", "PENDING_PAYMENT", "CANCELED", "EXPIRED"]);
    let status = rawStatus === "PENDING" ? "PENDING_PAYMENT" : rawStatus;
    if (!VALID.has(status)) status = "";

    const needsTicket = String(req.query?.needsTicket ?? "").toLowerCase() === "true";

    const maxAgeHoursRaw = req.query?.maxAgeHours;
    const maxAgeHours = maxAgeHoursRaw ? Number(maxAgeHoursRaw) : undefined;
    const createdAtFilter =
      status === "PENDING_PAYMENT" &&
      typeof maxAgeHours === "number" &&
      Number.isFinite(maxAgeHours)
        ? { gte: new Date(Date.now() - maxAgeHours * 3600 * 1000) }
        : undefined;

    const eventIdRaw = req.query?.eventId;
    const eventId = eventIdRaw ? Number(eventIdRaw) : undefined;

    const page = Math.max(1, parseInt(String(req.query?.page ?? "1"), 10) || 1);
    const pageSize = Math.min(50, Math.max(5, parseInt(String(req.query?.pageSize ?? "10"), 10) || 10));
    const skip = (page - 1) * pageSize;

    const now = new Date();

    const where: any = {
      ...(eventId && Number.isFinite(eventId) ? { eventId } : {}),
      ...(q
        ? {
            OR: [
              { event: { title: { contains: q, mode: "insensitive" } } },
              { buyer: { email: { contains: q, mode: "insensitive" } } },
              { buyer: { name: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {}),
      ...(isSuperadmin(req) ? {} : { event: { organizerId } }),
    };

    if (needsTicket) {
      where.AND = [
        ...(where.AND || []),
        { fulfillmentStatus: { in: ["WAITING_TICKET", "TICKET_REJECTED"] } },
        {
          OR: [
            { status: "PAID" },
            {
              AND: [
                { status: "PENDING_PAYMENT" },
                { ticketUploadDeadlineAt: { gt: now } },
                { payment: { status: "AUTHORIZED", authorizationExpiresAt: { gt: now } } },
              ],
            },
          ],
        },
      ];
    } else if (status) {
      where.status = status;
      if (createdAtFilter) where.createdAt = createdAtFilter;
    }

    const [total, rows] = await Promise.all([
      prisma.reservation.count({ where }),
      prisma.reservation.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        select: {
          id: true,
          createdAt: true,
          amount: true,
          quantity: true,
          status: true,
          fulfillmentStatus: true,
          ticketUploadedAt: true,
          ticketFilePath: true,
          ticketFileName: true,
          ticketMime: true,
          deliveredAt: true,
          ticketUploadDeadlineAt: true,
          refundStatus: true,
          event: { select: { id: true, title: true, date: true } },
          buyer: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);

    const items = rows.map((r) => {
      const hasTicket = !!r.ticketFilePath;
      const mime = r.ticketMime || (r.ticketFilePath ? guessMimeByExt(r.ticketFilePath) : undefined);
      const size = safeStatSize(r.ticketFilePath);
      const refunded = r.refundStatus && r.refundStatus !== "NONE";
      const deadlineExpired = nowIsAfter(r.ticketUploadDeadlineAt);

      const needsAction =
        !r.fulfillmentStatus ||
        r.fulfillmentStatus === "WAITING_TICKET" ||
        r.fulfillmentStatus === "TICKET_REJECTED";

      const canUpload =
        !refunded &&
        r.fulfillmentStatus !== "TICKET_APPROVED" &&
        r.fulfillmentStatus !== "DELIVERED" &&
        (
          r.status === "PAID" ||
          (r.status === "PENDING_PAYMENT" && (!!r.ticketUploadedAt || !deadlineExpired))
        );

      const showDeadline =
        needsAction && (r.status === "PAID" || r.status === "PENDING_PAYMENT") && !refunded && !!r.ticketUploadDeadlineAt;

      return {
        reservationId: r.id,
        createdAt: r.createdAt,
        event: r.event,
        buyer: r.buyer,
        quantity: r.quantity,
        amount: r.amount,
        status: r.status,
        fulfillmentStatus: r.fulfillmentStatus,
        ticketUploadedAt: r.ticketUploadedAt,
        deliveredAt: r.deliveredAt,
        ticketUploadDeadlineAt: r.ticketUploadDeadlineAt,
        deadlineExpired,
        hasTicket,
        mime,
        size,
        uploadUrl: `/api/organizer/reservations/${r.id}/ticket`,
        canUpload,
        showDeadline,
      };
    });

    return res.status(200).json({ items, total, page, pageSize });
  } catch (err: any) {
    console.error("organizerListReservations error:", err);
    return res.status(500).json({ error: err?.message || "Error listando reservas" });
  }
}

/* ============================================================
 *  ORGANIZER: subir archivo de ticket (con deadline)
 * ==========================================================*/
export async function organizerUploadTicket(req: Request, res: Response) {
  try {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) {
      return res.status(400).json({ error: "ID inválido" });
    }
    if (!isOrganizer(req) && !isSuperadmin(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) return res.status(400).json({ error: "Falta archivo 'ticket'" });

    const reservation = await prisma.reservation.findUnique({
      where: { id: reservationId },
      include: { event: true, payment: true },
    });
    if (!reservation) return res.status(404).json({ error: "Reserva no encontrada" });

    if (!isSuperadmin(req)) {
      const organizerId = (req as any).user?.id;
      if (!reservation.event || reservation.event.organizerId !== organizerId) {
        return res.status(403).json({ error: "No puedes subir para este evento" });
      }
    }

    const paymentAuthorized =
      !!reservation.payment &&
      reservation.payment.status === "AUTHORIZED" &&
      (!reservation.payment.authorizationExpiresAt ||
        new Date(reservation.payment.authorizationExpiresAt).getTime() > Date.now());

    if (!(reservation.status === "PAID" || paymentAuthorized)) {
      return res.status(409).json({
        error:
          "La reserva debe estar pagada o con pago pre-autorizado y vigente para poder subir la entrada.",
      });
    }

    let deadline = reservation.ticketUploadDeadlineAt;
    if (!deadline) {
      deadline = computeDeadline(reservation.paidAt, reservation.createdAt);
      await prisma.reservation.update({
        where: { id: reservationId },
        data: { ticketUploadDeadlineAt: deadline },
      });
    }

    if (reservation.refundStatus && reservation.refundStatus !== "NONE") {
      return res.status(409).json({ error: "Esta reserva está en proceso de reembolso o ya fue reembolsada." });
    }

    if (reservation.fulfillmentStatus === "TICKET_APPROVED" || reservation.fulfillmentStatus === "DELIVERED") {
      return res.status(409).json({ error: "La entrada ya fue aprobada/entregada; no se puede reemplazar." });
    }

    const deadlineExpired = nowIsAfter(deadline);
    if (deadlineExpired && !reservation.ticketUploadedAt) {
      return res.status(409).json({
        error:
          "Plazo para subir el archivo vencido. No es posible adjuntar la entrada; se procesará el reembolso.",
      });
    }

    const hash = sha256(file.path);

    const updated = await prisma.reservation.update({
      where: { id: reservationId },
      data: {
        ticketFilePath: file.path,
        ticketFileName: file.originalname,
        ticketMime: file.mimetype,
        ticketChecksum: hash,
        ticketUploadedAt: new Date(),
        fulfillmentStatus: "TICKET_UPLOADED",
        rejectionReason: null,
        approvedAt: null,
        approvedByAdminId: null,
      },
      include: { event: true },
    });

    return res.json({ ok: true, reservation: updated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error subiendo ticket" });
  }
}

/* ============================================================
 *  ADMIN: listado pendientes + preview/descarga
 * ==========================================================*/
export async function adminListPendingTickets(_req: Request, res: Response) {
  try {
    const list = await prisma.reservation.findMany({
      where: { fulfillmentStatus: "TICKET_UPLOADED" },
      orderBy: { ticketUploadedAt: "desc" },
      select: {
        id: true,
        ticketUploadedAt: true,
        ticketFilePath: true,
        ticketFileName: true,
        ticketMime: true,
        event: { select: { id: true, title: true } },
        buyer: { select: { id: true, email: true, name: true } },
      },
    });

    const items = list.map((r) => {
      const size = safeStatSize(r.ticketFilePath);
      return {
        reservationId: r.id,
        eventTitle: r.event?.title ?? "—",
        buyerName: r.buyer?.name ?? "—",
        buyerEmail: r.buyer?.email ?? "",
        ticketUploadedAt: r.ticketUploadedAt,
        fileUrl: r.ticketFilePath ? `/api/admin/reservations/${r.id}/ticket-file` : null,
        mime: r.ticketMime || (r.ticketFilePath ? guessMimeByExt(r.ticketFilePath) : null),
        size,
      };
    });

    return res.json({ items, total: items.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error listando pendientes" });
  }
}

export async function adminPreviewTicketFile(req: Request, res: Response) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ error: "No autorizado" });

    const id = Number(req.params.id);
    const r = await prisma.reservation.findUnique({
      where: { id },
      select: {
        ticketFilePath: true,
        ticketFileName: true,
        ticketMime: true,
      },
    });
    if (!r || !r.ticketFilePath) {
      return res.status(404).json({ error: "Archivo no encontrado" });
    }

    const abs = path.resolve(r.ticketFilePath);
    if (!fs.existsSync(abs)) {
      return res.status(404).json({ error: "Archivo no disponible" });
    }

    const modeRaw = String(req.query.mode || "inline").toLowerCase();
    const mode: "inline" | "attachment" = modeRaw === "attachment" ? "attachment" : "inline";

    const mime = r.ticketMime || guessMimeByExt(abs);
    const name = (r.ticketFileName || path.basename(abs)).trim().replace(/"/g, "") || "ticket";

    res.setHeader("Content-Type", mime);
    res.setHeader(
      "Content-Disposition",
      mode === "attachment" ? `attachment; filename="${name}"` : `inline; filename="${name}"`,
    );

    return res.sendFile(abs);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error mostrando archivo" });
  }
}

/* ============================================================
 *  ADMIN: aprobar (captura si aplica) + preparar payout + disparo
 * ==========================================================*/
export async function adminApproveTicket(req: Request, res: Response) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ error: "No autorizado" });
    const reservationId = Number(req.params.id);
    const adminId = (req as any).user?.id;

    const reservation = await prisma.reservation.findUnique({
      where: { id: reservationId },
      include: {
        payment: true,
      },
    });
    if (!reservation) return res.status(404).json({ error: "Reserva no encontrada" });
    if (reservation.fulfillmentStatus !== "TICKET_UPLOADED") {
      return res.status(409).json({ error: "La reserva no está en estado TICKET_UPLOADED" });
    }
    if (!reservation.ticketFilePath || !fs.existsSync(reservation.ticketFilePath)) {
      return res.status(409).json({ error: "Archivo no encontrado en servidor" });
    }

    const p = reservation.payment;
    if (!p) {
      return res.status(409).json({ error: "No existe transacción asociada a la reserva" });
    }

    // Helper para crear (si falta) y disparar payout
    const ensureAndTriggerPayout = async (txPay: typeof p) => {
      if (!txPay.destinationAccountId) {
        return { payoutId: null, note: "No hay cuenta destino del organizador para payout" };
      }

      // Validar cuenta destino y datos bancarios
      const account = await prisma.connectedAccount.findUnique({
        where: { id: txPay.destinationAccountId },
      });
      if (!account) {
        return { payoutId: null, note: "ConnectedAccount no encontrada" };
      }
      try {
        assertAccountReady(account);
      } catch (e: any) {
        return { payoutId: null, note: e?.message || "Cuenta destino no lista para payouts" };
      }

      // Crear payout idempotente si no existe
      let payout = await prisma.payout.findFirst({ where: { reservationId } });
      if (!payout) {
        const net = calculateOrganizerNetAmount({
          amount: txPay.amount,
          netAmount: txPay.netAmount,
          applicationFeeAmount: txPay.applicationFeeAmount,
        });
        payout = await prisma.payout.create({
          data: {
            accountId: txPay.destinationAccountId,
            reservationId,
            paymentId: txPay.id,
            amount: net,
            status: "PENDING",
            currency: "CLP",
            idempotencyKey: `payout_${Date.now()}_${reservationId}`,
          },
        });
      }

      // Disparar payout (puede tardar; esperamos la respuesta para reflejar estado)
      const payResp = await triggerPayout(payout.id);

      return { payoutId: payout.id, payoutOk: !!payResp.ok, note: payResp.error || null };
    };

    // ── Caso idempotente: ya capturado ───────────────────────────────────────────
    if (p.status === "CAPTURED") {
      const result = await prisma.$transaction(async (txp) => {
        const resv = await txp.reservation.update({
          where: { id: reservationId },
          data: {
            fulfillmentStatus: "TICKET_APPROVED",
            approvedAt: new Date(),
            approvedByAdminId: adminId,
            rejectionReason: null,
            status: "PAID",
            paidAt: reservation.paidAt ?? new Date(),
          },
        });

        // No crear payout en la transacción; lo hacemos fuera para llamar al PSP
        return { resv };
      });

      const { payoutId, payoutOk, note } = await ensureAndTriggerPayout(p);

      return res.json({
        ok: true,
        reservation: result.resv,
        captured: true,
        payoutId: payoutId ?? null,
        payoutDispatched: payoutOk ?? false,
        note: note ?? "Pago ya estaba capturado; se aprobó el ticket.",
      });
    }

    // ── Debe estar AUTHORIZED y vigente para capturar ───────────────────────────
    if (p.status !== "AUTHORIZED") {
      return res.status(409).json({ error: "La transacción no está pre-autorizada" });
    }
    if (!p.token || !p.buyOrder || !p.authorizationCode) {
      return res.status(409).json({ error: "Faltan datos para capturar (token/buyOrder/authorizationCode)" });
    }
    if (p.authorizationExpiresAt && new Date(p.authorizationExpiresAt).getTime() <= Date.now()) {
      return res.status(409).json({ error: "La autorización expiró; solicita reintento al comprador" });
    }

    // Captura en Webpay usando el servicio centralizado
    const cap = await captureWebpayPayment({
      token: p.token,
      buyOrder: p.buyOrder,
      authorizationCode: p.authorizationCode,
      amount: p.amount,
    });
    
    const ok = cap?.response_code === 0;
    if (!ok) {
      return res.status(409).json({
        ok: false,
        error: "Captura rechazada por el PSP",
        responseCode: cap?.response_code ?? null,
      });
    }

    const updated = await prisma.$transaction(async (txp) => {
      const pay = await txp.payment.update({
        where: { id: p.id },
        data: {
          status: "CAPTURED",
          capturedAmount: p.amount,
          capturedAt: new Date(),
          captureId: String(cap?.authorization_code ?? "") || null,
        },
      });

      const resv = await txp.reservation.update({
        where: { id: reservationId },
        data: {
          status: "PAID",
          paidAt: new Date(),
          fulfillmentStatus: "TICKET_APPROVED",
          approvedAt: new Date(),
          approvedByAdminId: adminId,
          rejectionReason: null,
        },
      });

      return { resv, pay };
    });

    // Disparar payout de forma asíncrona (fire-and-forget) para no bloquear la respuesta
    ensureAndTriggerPayout(updated.pay)
      .then(({ payoutId, payoutOk }) => {
        console.log(`✅ [APPROVE] Payout ${payoutId} disparado exitosamente (async): ${payoutOk}`);
      })
      .catch((payoutError) => {
        console.error('❌ [APPROVE] Error disparando payout (async):', payoutError);
      });

    return res.json({
      ok: true,
      reservation: updated.resv,
      captured: true,
      note: 'Ticket aprobado. Payout procesándose en background.',
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error aprobando/capturando ticket" });
  }
}

export async function adminRejectTicket(req: Request, res: Response) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ error: "No autorizado" });
    const reservationId = Number(req.params.id);
    const { reason } = req.body as { reason?: string };

    const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
    if (!reservation) return res.status(404).json({ error: "Reserva no encontrada" });
    if (reservation.fulfillmentStatus !== "TICKET_UPLOADED") {
      return res.status(409).json({ error: "La reserva no está en estado TICKET_UPLOADED" });
    }

    const updated = await prisma.reservation.update({
      where: { id: reservationId },
      data: {
        fulfillmentStatus: "TICKET_REJECTED",
        rejectionReason: (reason || "Rechazado por revisión").slice(0, 500),
        approvedAt: null,
        approvedByAdminId: null,
      },
    });

    return res.json({ ok: true, reservation: updated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error rechazando ticket" });
  }
}

/* ============================================================
 *  BUYER: preview/descarga + estados
 * ==========================================================*/
export async function buyerPreviewTicketFile(req: Request, res: Response) {
  try {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) {
      return res.status(400).json({ error: "ID inválido" });
    }
    if (!isBuyer(req) && !isSuperadmin(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const r = await prisma.reservation.findUnique({
      where: { id: reservationId },
      select: {
        id: true,
        buyerId: true,
        fulfillmentStatus: true,
        ticketFilePath: true,
        ticketFileName: true,
        ticketMime: true,
      },
    });
    if (!r) return res.status(404).json({ error: "Reserva no encontrada" });

    const userId = (req as any).user?.id;
    if (!isSuperadmin(req) && r.buyerId !== userId) {
      return res.status(403).json({ error: "No puedes acceder a esta entrada" });
    }

    const allowed = ["TICKET_APPROVED", "DELIVERED"];
    if (!allowed.includes(String(r.fulfillmentStatus))) {
      return res.status(409).json({ error: "La entrada aún no está aprobada" });
    }

    const abs = r.ticketFilePath ? path.resolve(r.ticketFilePath) : null;
    if (!abs || !fs.existsSync(abs)) {
      return res.status(409).json({ error: "Archivo no disponible" });
    }

    const modeRaw = String(req.query.mode || "inline").toLowerCase();
    const mode: "inline" | "attachment" = modeRaw === "attachment" ? "attachment" : "inline";

    const mime = r.ticketMime || guessMimeByExt(abs);
    const name = (r.ticketFileName || path.basename(abs)).trim().replace(/"/g, "") || "ticket";

    res.setHeader("Content-Type", mime);
    res.setHeader(
      "Content-Disposition",
      mode === "attachment" ? `attachment; filename="${name}"` : `inline; filename="${name}"`,
    );

    if (r.fulfillmentStatus !== "DELIVERED") {
      await prisma.reservation.update({
        where: { id: reservationId },
        data: { fulfillmentStatus: "DELIVERED", deliveredAt: new Date() },
      });
    }

    return res.sendFile(abs);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error mostrando archivo" });
  }
}

export async function buyerDownloadTicket(req: Request, res: Response) {
  try {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) {
      return res.status(400).json({ error: "ID inválido" });
    }
    if (!isBuyer(req) && !isSuperadmin(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const reservation = await prisma.reservation.findUnique({
      where: { id: reservationId },
      select: {
        id: true,
        buyerId: true,
        fulfillmentStatus: true,
        ticketFilePath: true,
        ticketFileName: true,
        generatedPdfPath: true,
        event: { select: { eventType: true, title: true } },
      },
    });
    if (!reservation) return res.status(404).json({ error: "Reserva no encontrada" });

    const userId = (req as any).user?.id;
    if (!isSuperadmin(req) && reservation.buyerId !== userId) {
      return res.status(403).json({ error: "No puedes descargar esta entrada" });
    }

    // Determinar qué archivo descargar según el tipo de evento
    let filePath: string | null = null;
    let fileName: string | null = null;

    // CASO 1: Evento OWN - Descargar PDF generado
    if (reservation.event.eventType === 'OWN') {
      if (!reservation.generatedPdfPath || !fs.existsSync(reservation.generatedPdfPath)) {
        return res.status(409).json({ error: "PDF del ticket aún no está disponible" });
      }
      filePath = reservation.generatedPdfPath;
      fileName = `ticket-${reservation.event.title.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    }
    // CASO 2: Evento RESALE - Descargar ticket físico escaneado (legacy)
    else {
      const allowed = ["TICKET_APPROVED", "DELIVERED"];
      if (!allowed.includes(String(reservation.fulfillmentStatus))) {
        return res.status(409).json({ error: "La entrada aún no está aprobada" });
      }
      if (!reservation.ticketFilePath || !fs.existsSync(reservation.ticketFilePath)) {
        return res.status(409).json({ error: "Archivo no disponible" });
      }
      filePath = reservation.ticketFilePath;
      fileName = reservation.ticketFileName?.trim() || path.basename(filePath);
    }

    // Marcar como entregado si no lo está
    if (reservation.fulfillmentStatus !== "DELIVERED") {
      await prisma.reservation.update({
        where: { id: reservationId },
        data: { fulfillmentStatus: "DELIVERED", deliveredAt: new Date() },
      });
    }

    const resolvedPath = path.resolve(filePath);
    const sanitizedName = fileName.replace(/"/g, "");
    return res.download(resolvedPath, sanitizedName);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error descargando ticket" });
  }
}

/**
 * GET /api/tickets/:id/status
 */
export async function getTicketFlowStatus(req: Request, res: Response) {
  try {
    const reservationId = Number(req.params.id);
    const r = await prisma.reservation.findUnique({
      where: { id: reservationId },
      select: {
        id: true,
        status: true,
        fulfillmentStatus: true,
        ticketUploadedAt: true,
        approvedAt: true,
        deliveredAt: true,
        rejectionReason: true,
        ticketUploadDeadlineAt: true,
        refundStatus: true,
        refundedAt: true,
      },
    });
    if (!r) return res.status(404).json({ error: "Reserva no encontrada" });
    return res.json(r);
  } catch {
    return res.status(500).json({ error: "Error consultando estado" });
  }
}

/**
 * GET /api/tickets/my
 */
export async function listMyTickets(req: Request, res: Response) {
  try {
    const userId = (req as any)?.user?.id as number | undefined;
    if (!userId) return res.status(401).json({ error: "No autenticado" });

    const q = String(req.query?.q ?? "").trim();
    const page = Math.max(1, parseInt(String(req.query?.page ?? "1"), 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query?.pageSize ?? "10"), 10) || 10));
    const skip = (page - 1) * pageSize;

    const where: any = {
      buyerId: userId,
      status: "PAID",
      ...(q ? { event: { title: { contains: q, mode: "insensitive" } } } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.reservation.count({ where }),
      prisma.reservation.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        select: {
          id: true,
          eventId: true,
          amount: true,
          quantity: true,
          code: true,
          status: true,
          paidAt: true,
          createdAt: true,
          expiresAt: true,
          fulfillmentStatus: true,
          ticketUploadedAt: true,
          deliveredAt: true,
          ticketFilePath: true,
          ticketMime: true,
          // Campos para eventos OWN
          generatedPdfPath: true,
          qrCode: true,
          seatAssignment: true,
          scanned: true,
          scannedAt: true,
          // Relación con ticket RESALE
          ticket: {
            select: {
              id: true,
              ticketCode: true,
              row: true,
              seat: true,
              zone: true,
              level: true,
              imageFileName: true,
              imageMime: true,
              sold: true,
              soldAt: true,
            },
          },
          event: {
            select: {
              id: true,
              title: true,
              date: true,
              eventType: true,
            },
          },
          ticketUploadDeadlineAt: true,
          refundStatus: true,
        },
      }),
    ]);

    const items = rows.map((r) => {
      const flow =
        r.fulfillmentStatus || (r.ticketUploadedAt ? "UNDER_REVIEW" : "WAITING_TICKET");
      const canDownload = flow === "TICKET_APPROVED" || flow === "DELIVERED" || r.generatedPdfPath;
      const mime = r.ticketMime || (r.ticketFilePath ? guessMimeByExt(r.ticketFilePath) : undefined);
      const size = safeStatSize(r.ticketFilePath);

      return {
        reservationId: r.id,
        id: r.id,
        eventId: r.eventId,
        code: r.code,
        status: r.status,
        paidAt: r.paidAt,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        event: r.event,
        quantity: r.quantity,
        amount: r.amount,
        // Campos OWN
        generatedPdfPath: r.generatedPdfPath,
        qrCode: r.qrCode,
        seatAssignment: r.seatAssignment,
        scanned: r.scanned,
        scannedAt: r.scannedAt,
        // Ticket RESALE
        ticket: r.ticket,
        // Legacy
        flowStatus: flow,
        ticketUploadedAt: r.ticketUploadedAt,
        deliveredAt: r.deliveredAt,
        ticketUploadDeadlineAt: r.ticketUploadDeadlineAt,
        refundStatus: r.refundStatus,
        canDownload,
        canPreview: canDownload,
        previewUrl: `/api/tickets/${r.id}/file`,
        downloadUrl: `/api/tickets/${r.id}/download`,
        mime,
        size,
      };
    });

    return res.status(200).json({ items, total, page, pageSize });
  } catch (err: any) {
    console.error("listMyTickets error:", err);
    return res.status(500).json({ error: err?.message || "Error listando entradas" });
  }
}

/* ============================================================
 *  JOB: barrer reservas vencidas y reembolsar
 * ==========================================================*/
export async function sweepOverdueReservations(req: Request, res: Response) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ error: "No autorizado" });
    const limit = Math.max(1, Math.min(500, Number((req.body as any)?.limit ?? 100)));

    const now = new Date();

    const overdue = await prisma.reservation.findMany({
      where: {
        status: "PAID",
        ticketUploadedAt: null,
        ticketUploadDeadlineAt: { lte: now },
        refundStatus: "NONE",
      },
      orderBy: { ticketUploadDeadlineAt: "asc" },
      take: limit,
      include: { payment: true },
    });

    const results: Array<{ reservationId: number; ok: boolean; reason?: string }> = [];

    for (const r of overdue) {
      try {
        if (!r.payment || (r.payment.status !== "COMMITTED" && r.payment.status !== "CAPTURED")) {
          await prisma.reservation.update({
            where: { id: r.id },
            data: {
              status: "CANCELED",
              refundStatus: "FAILED",
              refundReason: "No hay pago confirmado asociado",
            },
          });
          results.push({ reservationId: r.id, ok: false, reason: "sin payment confirmado" });
          continue;
        }

        const p = r.payment;
        const refund = await refundPayment({ id: p.id, amount: p.amount, buyOrder: p.buyOrder });

        await prisma.$transaction([
          prisma.payment.update({
            where: { id: p.id },
            data: {
              status: "REFUNDED",
              refundedAmount: p.amount,
              lastRefundAt: new Date(),
            },
          }),
          prisma.reservation.update({
            where: { id: r.id },
            data: {
              status: "CANCELED",
              refundStatus: "SUCCEEDED",
              refundedAt: new Date(),
              refundId: refund.id,
              refundReason: `Deadline vencido (${DEADLINE_HOURS}h)`,
            },
          }),
        ]);

        results.push({ reservationId: r.id, ok: true });
      } catch (inner) {
        console.error("refund error", inner);
        await prisma.reservation.update({
          where: { id: r.id },
          data: { refundStatus: "FAILED", refundReason: "Fallo al reembolsar" },
        });
        results.push({ reservationId: r.id, ok: false, reason: "error psp" });
      }
    }

    return res.json({ processed: results.length, results });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error en barrido de vencidos" });
  }
}

/* ============================================================
 *  NUEVO: Detalle/refresh de reserva para el comprador
 * ==========================================================*/

/** GET /api/tickets/reservations/:id */
export async function getReservationDetail(req: Request, res: Response) {
  try {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const r = await prisma.reservation.findUnique({
      where: { id: reservationId },
      include: {
        event: { select: { id: true, title: true, date: true, location: true, coverImageUrl: true } },
        payment: true,
      },
    });
    if (!r) return res.status(404).json({ error: "Reserva no encontrada" });
    if (!ensureBuyerOrAdmin(r, req)) return res.status(403).json({ error: "No autorizado" });

    return res.json(buildReservationDetail(r));
  } catch (err) {
    console.error("getReservationDetail error:", err);
    return res.status(500).json({ error: "Error obteniendo la reserva" });
  }
}

/** POST /api/tickets/reservations/:id/refresh-payment */
export async function refreshReservationPayment(req: Request, res: Response) {
  try {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) return res.status(400).json({ error: "ID inválido" });

    const r = await prisma.reservation.findUnique({
      where: { id: reservationId },
      include: { payment: true, event: true },
    });
    if (!r) return res.status(404).json({ error: "Reserva no encontrada" });
    if (!ensureBuyerOrAdmin(r, req)) return res.status(403).json({ error: "No autorizado" });

    const p = r.payment;
    if (p?.token) {
      try {
        const st: any = await getWebpayStatus(p.token);
        const mapped = mapTbkStatusToLocal(st?.status);

        const data: any = {
          // campos comunes que conviene mantener al día
          responseCode: typeof st?.response_code === "number" ? st.response_code : p.responseCode,
          authorizationCode: st?.authorization_code || p.authorizationCode || null,
          paymentTypeCode: st?.payment_type_code || p.paymentTypeCode || null,
          installmentsNumber: typeof st?.installments_number === "number" ? st.installments_number : p.installmentsNumber,
          accountingDate: st?.accounting_date || p.accountingDate || null,
          transactionDate: st?.transaction_date ? new Date(st.transaction_date) : p.transactionDate,
          vci: st?.vci || p.vci || null,
          cardLast4: st?.card_detail?.card_number ? String(st.card_detail.card_number).slice(-4) : p.cardLast4 || null,
          commerceCode: st?.commerce_code || p.commerceCode || null,
          environment: env.WEBPAY_ENV || p.environment || null,
        };

        if (mapped === "AUTHORIZED") {
          data.status = "AUTHORIZED";
          data.authorizedAmount = typeof st?.amount === "number" ? Math.round(st.amount) : (p.authorizedAmount ?? p.amount);
          // Si quieres estimar expiración de la autorización, puedes setear authorizationExpiresAt aquí.
        } else if (mapped === "COMMITTED") {
          data.status = "COMMITTED";
        } else if (mapped === "VOIDED") {
          data.status = "VOIDED";
          data.voidedAt = new Date();
        } else if (mapped === "FAILED") {
          data.status = "FAILED";
        }

        await prisma.payment.update({ where: { id: p.id }, data });
      } catch (e) {
        // No hacemos fail duro si status falla; devolvemos lo que tengamos
        console.warn("refreshReservationPayment status error:", e);
      }
    }

    // Devolvemos el detalle actualizado
    const fresh = await prisma.reservation.findUnique({
      where: { id: reservationId },
      include: {
        event: { select: { id: true, title: true, date: true, location: true, coverImageUrl: true } },
        payment: true,
      },
    });
    if (!fresh) return res.status(404).json({ error: "Reserva no encontrada" });
    return res.json(buildReservationDetail(fresh));
  } catch (err) {
    console.error("refreshReservationPayment error:", err);
    return res.status(500).json({ error: "Error refrescando estado del pago" });
  }
}

/** POST /api/tickets/reservations/:id/refresh-ticket */
export async function refreshReservationTicket(req: Request, res: Response) {
  try {
    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) return res.status(400).json({ error: "ID inválido" });

    const r = await prisma.reservation.findUnique({
      where: { id: reservationId },
      select: {
        id: true,
        buyerId: true,
        status: true,
        fulfillmentStatus: true,
        ticketUploadedAt: true,
        approvedAt: true,
        deliveredAt: true,
        rejectionReason: true,
        ticketUploadDeadlineAt: true,
        refundStatus: true,
        refundedAt: true,
      },
    });
    if (!r) return res.status(404).json({ error: "Reserva no encontrada" });
    if (!ensureBuyerOrAdmin(r, req)) return res.status(403).json({ error: "No autorizado" });

    // Por ahora solo devolvemos el estado actual (si quieres, aquí puedes
    // añadir lógica adicional para mover a DELIVERED, etc.)
    return res.json(r);
  } catch (err) {
    console.error("refreshReservationTicket error:", err);
    return res.status(500).json({ error: "Error refrescando estado del ticket" });
  }
}












