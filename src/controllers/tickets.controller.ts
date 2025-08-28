// src/controllers/tickets.controller.ts
import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import prisma from "../prisma/client";

const DEADLINE_HOURS = Number(process.env.TICKET_UPLOAD_DEADLINE_HOURS ?? 24);

function isSuperadmin(req: Request) {
  return (req as any).user?.role === "superadmin";
}
function isOrganizer(req: Request) {
  return (req as any).user?.role === "organizer";
}
function isBuyer(req: Request) {
  return (req as any).user?.role === "buyer";
}

function sha256(filePath: string) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function guessMimeByExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

function safeStatSize(filePath?: string | null): number | null {
  try {
    if (!filePath) return null;
    if (!fs.existsSync(filePath)) return null;
    const st = fs.statSync(filePath);
    return st.size ?? null;
  } catch {
    return null;
  }
}

function computeDeadline(paidAt?: Date | null, createdAt?: Date | null) {
  const base = paidAt ?? createdAt ?? new Date();
  const ms = DEADLINE_HOURS * 3600 * 1000;
  return new Date(new Date(base).getTime() + ms);
}

function nowIsAfter(d?: Date | null) {
  if (!d) return false;
  return Date.now() > new Date(d).getTime();
}

/* ============================================================
 *  Reembolsos (STUB): reemplazar por PSP real
 * ==========================================================*/
async function refundPayment(payment: { id: number; amount: number; buyOrder: string }) {
  // TODO: integra con tu PSP (Webpay/Transbank: refund; Stripe: refunds.create, etc.)
  // Simulamos éxito y devolvemos un id de reembolso:
  return { id: `rf_${payment.id}_${Date.now()}`, amount: payment.amount };
}

/* ============================================================
 *  ORGANIZER: LISTAR RESERVAS (para tabla en misma página)
 * ==========================================================*/
/**
 * GET /api/organizer/reservations
 * Query:
 *  - page, pageSize
 *  - q                 (busca por título del evento o comprador name/email)
 *  - status            ("PAID" | "PENDING_PAYMENT" | "CANCELED" | "EXPIRED" | "")
 *  - needsTicket       (boolean) si true → muestra solo PAID que requieren acción
 *                      (fulfillmentStatus: WAITING_TICKET | TICKET_REJECTED)
 *  - maxAgeHours       (number) opcional para limitar PENDING_PAYMENT por antigüedad
 *  - eventId           (opcional, filtra por evento)
 */
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
    if (!VALID.has(status)) status = ""; // si mandan algo inválido o vacío, no filtramos por status

    // Toggle para "solo requiere acción"
    const needsTicket = String(req.query?.needsTicket ?? "").toLowerCase() === "true";

    // Opcional: limitar antigüedad cuando status=PENDING_PAYMENT (en horas)
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

    // Base del where
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
      // Solo reservas de eventos del organizador (a menos que sea superadmin)
      ...(isSuperadmin(req) ? {} : { event: { organizerId } }),
    };

    if (needsTicket) {
      // ✅ Requiere acción del organizador: pagadas y NO completadas
      where.AND = [
        ...(where.AND || []),
        { status: "PAID" },
        { fulfillmentStatus: { in: ["WAITING_TICKET", "TICKET_REJECTED"] } },
      ];
    } else if (status) {
      // Filtro normal por status (PAID, PENDING_PAYMENT, etc.)
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
          ticketUploadDeadlineAt: true, // nuevo
          refundStatus: true,           // nuevo
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

      // ¿Realmente hay acción pendiente del organizador?
      const needsAction =
        !r.fulfillmentStatus ||
        r.fulfillmentStatus === "WAITING_TICKET" ||
        r.fulfillmentStatus === "TICKET_REJECTED";

      /**
       * ✔️ Se puede subir si:
       * - está PAID
       * - no está reembolsada
       * - NO está APPROVED ni DELIVERED
       * - y:
       *   a) si nunca subió: el plazo NO venció
       *   b) si ya subió (UPLOADED/REJECTED): puede reemplazar aun vencido
       */
      const canUpload =
        r.status === "PAID" &&
        !refunded &&
        r.fulfillmentStatus !== "TICKET_APPROVED" &&
        r.fulfillmentStatus !== "DELIVERED" &&
        (!r.ticketUploadedAt ? !deadlineExpired : true);

      // Mostrar “Plazo” solo si hay acción pendiente
      const showDeadline =
        needsAction && r.status === "PAID" && !refunded && !!r.ticketUploadDeadlineAt;

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
        // opcional para el front:
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
/**
 * POST /api/organizer/reservations/:id/ticket
 * body (form-data): ticket (pdf|png|jpg)
 */
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

    // El organizador dueño del evento debe subir el archivo (salvo superadmin)
    const organizerId = (req as any).user?.id;
    if (!isSuperadmin(req)) {
      if (!reservation.event || reservation.event.organizerId !== organizerId) {
        return res.status(403).json({ error: "No puedes subir para este evento" });
      }
    }

    // Solo si está pagada
    if (reservation.status !== "PAID") {
      return res.status(409).json({ error: "La reserva no está pagada" });
    }

    // Si no tiene deadline aún (viejas), lo fijamos a partir de paidAt/createdAt
    let deadline = reservation.ticketUploadDeadlineAt;
    if (!deadline) {
      deadline = computeDeadline(reservation.paidAt, reservation.createdAt);
      await prisma.reservation.update({
        where: { id: reservationId },
        data: { ticketUploadDeadlineAt: deadline },
      });
    }

    // Si ya se reembolsó o se solicitó reembolso, bloquear
    if (reservation.refundStatus && reservation.refundStatus !== "NONE") {
      return res.status(409).json({ error: "Esta reserva está en proceso de reembolso o ya fue reembolsada." });
    }

    /**
     * ❗️NUEVO: si ya fue aprobada/entregada, no se permite reemplazar.
     */
    if (reservation.fulfillmentStatus === "TICKET_APPROVED" || reservation.fulfillmentStatus === "DELIVERED") {
      return res.status(409).json({ error: "La entrada ya fue aprobada/entregada; no se puede reemplazar." });
    }

    /**
     * Mantener la regla de plazo solo si aún no hay ticket subido (primera subida).
     * Si hubo un archivo antes (UPLOADED/REJECTED), sí permitimos reemplazar aun vencido.
     */
    if (nowIsAfter(deadline) && !reservation.ticketUploadedAt) {
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
      mode === "attachment" ? `attachment; filename="${name}"` : `inline; filename="${name}"`
    );

    return res.sendFile(abs);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error mostrando archivo" });
  }
}

export async function adminApproveTicket(req: Request, res: Response) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ error: "No autorizado" });
    const reservationId = Number(req.params.id);
    const adminId = (req as any).user?.id;

    const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
    if (!reservation) return res.status(404).json({ error: "Reserva no encontrada" });
    if (reservation.fulfillmentStatus !== "TICKET_UPLOADED") {
      return res.status(409).json({ error: "La reserva no está en estado TICKET_UPLOADED" });
    }
    if (!reservation.ticketFilePath || !fs.existsSync(reservation.ticketFilePath)) {
      return res.status(409).json({ error: "Archivo no encontrado en servidor" });
    }

    const updated = await prisma.reservation.update({
      where: { id: reservationId },
      data: {
        fulfillmentStatus: "TICKET_APPROVED",
        approvedAt: new Date(),
        approvedByAdminId: adminId,
        rejectionReason: null,
      },
    });

    return res.json({ ok: true, reservation: updated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error aprobando ticket" });
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

    // dueño o superadmin
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
      mode === "attachment" ? `attachment; filename="${name}"` : `inline; filename="${name}"`
    );

    // Si aún no estaba como entregado y solo lo previsualiza, lo marcamos entregado igual
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
      },
    });
    if (!reservation) return res.status(404).json({ error: "Reserva no encontrada" });

    // El comprador debe ser el dueño (salvo superadmin)
    const userId = (req as any).user?.id;
    if (!isSuperadmin(req) && reservation.buyerId !== userId) {
      return res.status(403).json({ error: "No puedes descargar esta entrada" });
    }

    // permitir descargar si está APROBADA o ya ENTREGADA
    const allowed = ["TICKET_APPROVED", "DELIVERED"];
    if (!allowed.includes(String(reservation.fulfillmentStatus))) {
      return res.status(409).json({ error: "La entrada aún no está aprobada" });
    }
    if (!reservation.ticketFilePath || !fs.existsSync(reservation.ticketFilePath)) {
      return res.status(409).json({ error: "Archivo no disponible" });
    }

    // Marcar como entregado (idempotente)
    if (reservation.fulfillmentStatus !== "DELIVERED") {
      await prisma.reservation.update({
        where: { id: reservationId },
        data: { fulfillmentStatus: "DELIVERED", deliveredAt: new Date() },
      });
    }

    const filePath = path.resolve(reservation.ticketFilePath);
    const fileName = (reservation.ticketFileName?.trim() || path.basename(filePath)).replace(/"/g, "");
    return res.download(filePath, fileName);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error descargando ticket" });
  }
}

/**
 * GET /api/tickets/:id/status
 * — útil para que el front muestre el banner/aviso
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
        ticketUploadDeadlineAt: true, // nuevo
        refundStatus: true,           // nuevo
        refundedAt: true,             // nuevo
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
 * — listado para el comprador autenticado
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
          amount: true,
          quantity: true,
          createdAt: true,
          fulfillmentStatus: true,
          ticketUploadedAt: true,
          deliveredAt: true,
          ticketFilePath: true,
          ticketMime: true,
          event: { select: { title: true, date: true } },
          ticketUploadDeadlineAt: true, // nuevo
          refundStatus: true,           // nuevo
        },
      }),
    ]);

    const items = rows.map((r) => {
      const flow =
        r.fulfillmentStatus || (r.ticketUploadedAt ? "UNDER_REVIEW" : "WAITING_TICKET");
      const canDownload = flow === "TICKET_APPROVED" || flow === "DELIVERED";
      const mime = r.ticketMime || (r.ticketFilePath ? guessMimeByExt(r.ticketFilePath) : undefined);
      const size = safeStatSize(r.ticketFilePath);

      return {
        reservationId: r.id,
        createdAt: r.createdAt,
        event: r.event,
        quantity: r.quantity,
        amount: r.amount,
        flowStatus: flow,
        ticketUploadedAt: r.ticketUploadedAt,
        deliveredAt: r.deliveredAt,
        ticketUploadDeadlineAt: r.ticketUploadDeadlineAt, // nuevo
        refundStatus: r.refundStatus,                     // nuevo
        canDownload,
        canPreview: canDownload, // misma condición: solo APROBADO/ENTREGADO
        previewUrl: `/api/tickets/${r.id}/file`, // inline por defecto
        downloadUrl: `/api/tickets/${r.id}/download`,
        mime,
        size, // bytes (null si no disponible)
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
/**
 * POST /api/admin/tickets/sweep-overdue
 * Body: { limit?: number } (opcional)
 * Requiere superadmin. Recorre PAID sin ticket subido cuyo deadline venció.
 */
export async function sweepOverdueReservations(req: Request, res: Response) {
  try {
    if (!isSuperadmin(req)) return res.status(403).json({ error: "No autorizado" });
    const limit = Math.max(1, Math.min(500, Number((req.body as any)?.limit ?? 100)));

    const now = new Date();

    const overdue = await prisma.reservation.findMany({
      where: {
        status: "PAID",
        ticketUploadedAt: null, // no subieron nada dentro del plazo
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
        if (!r.payment || r.payment.status !== "COMMITTED") {
          // Sin pago confirmado: solo marca cancelada y refund failed con razón
          await prisma.reservation.update({
            where: { id: r.id },
            data: {
              status: "CANCELED",
              refundStatus: "FAILED",
              refundReason: "No hay pago COMMITTED asociado",
            },
          });
          results.push({ reservationId: r.id, ok: false, reason: "sin payment COMMITTED" });
          continue;
        }

        // Ejecuta reembolso (PSP)
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






