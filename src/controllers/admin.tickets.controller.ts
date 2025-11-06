// src/controllers/admin.tickets.controller.ts
/**
 * ⚠️ CONTROLLER LEGACY - SOLO PARA RESERVAS HISTÓRICAS
 * 
 * Este controller mantiene endpoints para gestionar reservas LEGACY
 * (antiguas) que usaban el flujo manual de aprobación de tickets.
 * 
 * ❌ NO USAR PARA NUEVAS RESERVAS
 * 
 * NUEVO FLUJO: Generación automática con retry en ticketGeneration.service.ts
 * 
 * Este archivo se mantiene SOLO para:
 * 1. Aprobar/rechazar tickets de reservas antiguas
 * 2. Ver archivos de tickets subidos manualmente
 * 3. Barrido de reservas vencidas (refund automático)
 */

import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import prisma from "../prisma/client";
import { env } from "../config/env";

const DEADLINE_HOURS = Number(env.TICKET_UPLOAD_DEADLINE_HOURS ?? 24);

function isSuperadmin(req: Request) {
  return (req as any).user?.role === "superadmin";
}

function isOrganizer(req: Request) {
  return (req as any).user?.role === "organizer";
}

function guessMimeByExt(filePath?: string | null): string | null {
  if (!filePath) return null;
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if ([".jpg", ".jpeg"].includes(ext)) return "image/jpeg";
  return "application/octet-stream";
}

function safeStatSize(filePath?: string | null): number {
  if (!filePath) return 0;
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function sha256(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3600 * 1000);
}

function nowIsAfter(d?: Date | null): boolean {
  if (!d) return false;
  return Date.now() > new Date(d).getTime();
}

function computeDeadline(paidAt?: Date | null, createdAt?: Date | null): Date {
  const base = paidAt ?? createdAt ?? new Date();
  return addHours(base, DEADLINE_HOURS);
}

/* ============================================================
 *  ADMIN: Listar reservas pendientes de aprobación
 * ==========================================================*/
export async function adminListPendingTickets(req: Request, res: Response) {
  try {
    if (!isSuperadmin(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const page = Math.max(1, parseInt(String(req.query?.page ?? "1"), 10) || 1);
    const pageSize = Math.min(50, Math.max(5, parseInt(String(req.query?.pageSize ?? "10"), 10) || 10));
    const skip = (page - 1) * pageSize;

    const now = new Date();

    // Solo reservas LEGACY que tienen fulfillmentStatus y están pendientes
    const where: any = {
      fulfillmentStatus: { in: ["TICKET_UPLOADED", "TICKET_REJECTED"] },
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
    };

    const [total, rows] = await Promise.all([
      prisma.reservation.count({ where }),
      prisma.reservation.findMany({
        where,
        orderBy: { ticketUploadedAt: "desc" },
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
          rejectionReason: true,
          event: { select: { id: true, title: true, date: true } },
          buyer: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);

    const items = rows.map((r) => ({
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
      rejectionReason: r.rejectionReason,
      hasTicket: !!r.ticketFilePath,
      mime: r.ticketMime || guessMimeByExt(r.ticketFilePath),
    }));

    return res.status(200).json({ items, total, page, pageSize });
  } catch (err: any) {
    console.error("adminListPendingTickets error:", err);
    return res.status(500).json({ error: err?.message || "Error listando tickets pendientes" });
  }
}

/* ============================================================
 *  ADMIN: Aprobar ticket (flujo LEGACY)
 * ==========================================================*/
export async function adminApproveTicket(req: Request, res: Response) {
  try {
    if (!isSuperadmin(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const reservation = await prisma.reservation.findUnique({
      where: { id: reservationId },
      include: { payment: true },
    });

    if (!reservation) {
      return res.status(404).json({ error: "Reserva no encontrada" });
    }

    if (reservation.fulfillmentStatus === "TICKET_APPROVED" || reservation.fulfillmentStatus === "DELIVERED") {
      return res.status(409).json({ error: "El ticket ya fue aprobado" });
    }

    const adminId = (req as any).user?.id;

    await prisma.reservation.update({
      where: { id: reservationId },
      data: {
        fulfillmentStatus: "TICKET_APPROVED",
        approvedAt: new Date(),
        approvedByAdminId: adminId,
        rejectionReason: null,
      },
    });

    return res.json({ ok: true, message: "Ticket aprobado" });
  } catch (err: any) {
    console.error("adminApproveTicket error:", err);
    return res.status(500).json({ error: err?.message || "Error aprobando ticket" });
  }
}

/* ============================================================
 *  ADMIN: Rechazar ticket (flujo LEGACY)
 * ==========================================================*/
export async function adminRejectTicket(req: Request, res: Response) {
  try {
    if (!isSuperadmin(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const reason = String((req.body as any)?.reason ?? "").trim() || "No especificado";

    const reservation = await prisma.reservation.findUnique({
      where: { id: reservationId },
    });

    if (!reservation) {
      return res.status(404).json({ error: "Reserva no encontrada" });
    }

    await prisma.reservation.update({
      where: { id: reservationId },
      data: {
        fulfillmentStatus: "TICKET_REJECTED",
        rejectionReason: reason,
        approvedAt: null,
        approvedByAdminId: null,
      },
    });

    return res.json({ ok: true, message: "Ticket rechazado" });
  } catch (err: any) {
    console.error("adminRejectTicket error:", err);
    return res.status(500).json({ error: err?.message || "Error rechazando ticket" });
  }
}

/* ============================================================
 *  ADMIN: Vista previa/descarga de archivo de ticket LEGACY
 * ==========================================================*/
export async function adminPreviewTicketFile(req: Request, res: Response) {
  try {
    if (!isSuperadmin(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const reservationId = Number(req.params.id);
    if (!Number.isFinite(reservationId)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const mode = String(req.query?.mode ?? "inline").toLowerCase();

    const reservation = await prisma.reservation.findUnique({
      where: { id: reservationId },
      select: { ticketFilePath: true, ticketFileName: true, ticketMime: true },
    });

    if (!reservation || !reservation.ticketFilePath) {
      return res.status(404).json({ error: "Archivo de ticket no encontrado" });
    }

    const filePath = reservation.ticketFilePath;
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Archivo físico no existe" });
    }

    const mime = reservation.ticketMime || guessMimeByExt(filePath) || "application/octet-stream";
    const filename = reservation.ticketFileName || `ticket-${reservationId}`;

    res.setHeader("Content-Type", mime);
    const disposition = mode === "attachment" ? "attachment" : "inline";
    res.setHeader("Content-Disposition", `${disposition}; filename="${filename}"`);

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (err: any) {
    console.error("adminPreviewTicketFile error:", err);
    return res.status(500).json({ error: "Error al acceder al archivo" });
  }
}

/* ============================================================
 *  ADMIN: Barrido de reservas vencidas (refund automático)
 * ==========================================================*/
export async function sweepOverdueReservations(req: Request, res: Response) {
  try {
    if (!isSuperadmin(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const limit = Math.max(1, Math.min(500, Number((req.body as any)?.limit ?? 100)));
    const now = new Date();

    // Solo reservas LEGACY con fulfillmentStatus
    const overdue = await prisma.reservation.findMany({
      where: {
        status: "PAID",
        ticketUploadedAt: null,
        ticketUploadDeadlineAt: { lte: now },
        refundStatus: "NONE",
        fulfillmentStatus: { notIn: [null, "DELIVERED", "TICKET_APPROVED"] as any },
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

        // Aquí deberías integrar con tu PSP para hacer refund real
        // const refund = await refundPayment({ id: p.id, amount: p.amount, buyOrder: p.buyOrder });

        const p = r.payment;
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
              refundReason: `Deadline vencido (${DEADLINE_HOURS}h)`,
            },
          }),
        ]);

        results.push({ reservationId: r.id, ok: true });
      } catch (inner) {
        console.error("sweep refund error", inner);
        await prisma.reservation.update({
          where: { id: r.id },
          data: { refundStatus: "FAILED", refundReason: "Fallo al reembolsar" },
        });
        results.push({ reservationId: r.id, ok: false, reason: "error psp" });
      }
    }

    return res.json({ processed: results.length, results });
  } catch (err: any) {
    console.error("sweepOverdueReservations error:", err);
    return res.status(500).json({ error: "Error en barrido de vencidos" });
  }
}

/* ============================================================
 *  ORGANIZER: Listar reservas (para tabla LEGACY)
 * ==========================================================*/
export async function organizerListReservations(req: Request, res: Response) {
  try {
    if (!isOrganizer(req) && !isSuperadmin(req)) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const organizerId = (req as any).user?.id as number | undefined;
    const q = String(req.query?.q ?? "").trim();

    const rawStatus = String(req.query?.status ?? "").trim().toUpperCase();
    const VALID = new Set(["PAID", "PENDING_PAYMENT", "CANCELED", "EXPIRED"]);
    let status = rawStatus === "PENDING" ? "PENDING_PAYMENT" : rawStatus;
    if (!VALID.has(status)) status = "";

    const needsTicket = String(req.query?.needsTicket ?? "").toLowerCase() === "true";
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
      // Solo LEGACY (con fulfillmentStatus no nulo)
      fulfillmentStatus: { notIn: [null] as any },
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
      const mime = r.ticketMime || guessMimeByExt(r.ticketFilePath);
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
        (r.status === "PAID" || (r.status === "PENDING_PAYMENT" && (!!r.ticketUploadedAt || !deadlineExpired)));

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
 *  ORGANIZER: Subir archivo de ticket LEGACY (con deadline)
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
        error: "La reserva debe estar pagada o con pago pre-autorizado y vigente para poder subir la entrada.",
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
        error: "Plazo para subir el archivo vencido. No es posible adjuntar la entrada; se procesará el reembolso.",
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
  } catch (err: any) {
    console.error("organizerUploadTicket error:", err);
    return res.status(500).json({ error: "Error subiendo ticket" });
  }
}
