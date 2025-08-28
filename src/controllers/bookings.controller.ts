// src/controllers/bookings.controller.ts
import { Request, Response } from "express";
import prisma from "../prisma/client";
import { Prisma } from "@prisma/client";

type Authed = Request & { user?: { id: number; role: string; verifiedOrganizer?: boolean } };

const HOLD_MINUTES = 10;
const MAX_PER_PURCHASE = 4;

/* ===================== Helpers ===================== */
function parseIntSafe(v: unknown, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : def;
}

/** Stock restante considerando PAID + PENDING_PAYMENT no vencidos */
async function remainingForEvent(
  tx: Prisma.TransactionClient | typeof prisma,
  eventId: number
) {
  const ev = await tx.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      capacity: true,
      price: true,
      organizerId: true,
      date: true,
      approved: true,
    },
  });
  if (!ev) {
    const e = new Error("EVENT_NOT_FOUND") as any;
    e.status = 404;
    throw e;
  }

  const now = new Date();
  const agg = await tx.reservation.aggregate({
    _sum: { quantity: true },
    where: {
      eventId,
      OR: [
        { status: "PAID" as any },
        { status: "PENDING_PAYMENT" as any, expiresAt: { gt: now } },
      ],
    },
  });
  const used = agg._sum.quantity ?? 0;
  const remaining = Math.max(0, ev.capacity - used);
  const startsAt = ev.date instanceof Date ? ev.date : new Date(ev.date);
  const hasStarted = now >= startsAt;

  return { ev, remaining, hasStarted };
}

/* ===================== HOLD ===================== */
/** POST /api/bookings/hold  (auth) – crea reserva temporal */
export async function holdReservation(req: Authed, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });

    const eventId = parseIntSafe((req.body as any)?.eventId);
    const quantity = parseIntSafe((req.body as any)?.quantity ?? (req.body as any)?.qty);
    if (!eventId || !quantity || quantity < 1) {
      return res.status(422).json({ ok: false, error: "INVALID_INPUT" });
    }
    if (quantity > MAX_PER_PURCHASE) {
      return res
        .status(422)
        .json({ ok: false, error: "MAX_PER_PURCHASE_EXCEEDED", max: MAX_PER_PURCHASE });
    }

    const booking = await prisma.$transaction(
      async (tx) => {
        const { ev, remaining, hasStarted } = await remainingForEvent(tx, eventId);

        if (hasStarted) {
          const e = new Error("EVENT_HAS_STARTED") as any;
          e.status = 400;
          throw e;
        }
        if (!ev.approved) {
          const e = new Error("EVENT_NOT_APPROVED") as any;
          e.status = 400;
          throw e;
        }
        // 🚫 organizador no puede comprar su propio evento
        if (ev.organizerId === userId) {
          const e = new Error("CANNOT_BUY_OWN_EVENT") as any;
          e.status = 403;
          throw e;
        }

        if (remaining < quantity) {
          const e = new Error("INSUFFICIENT_STOCK") as any;
          e.status = 409;
          e.remaining = remaining;
          throw e;
        }

        const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60_000);
        const amount = (ev.price ?? 0) * quantity;

        const r = await tx.reservation.create({
          data: {
            eventId,
            buyerId: userId,
            quantity,
            status: "PENDING_PAYMENT" as any,
            expiresAt,
            amount,
            // code se genera con @default(uuid())
          },
          select: { id: true, code: true, quantity: true, amount: true, expiresAt: true },
        });

        return r;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    return res.json({ ok: true, booking, holdMinutes: HOLD_MINUTES });
  } catch (err: any) {
    const status = err?.status ?? 500;
    if (
      [
        "EVENT_NOT_FOUND",
        "INSUFFICIENT_STOCK",
        "EVENT_HAS_STARTED",
        "EVENT_NOT_APPROVED",
        "CANNOT_BUY_OWN_EVENT",
      ].includes(err?.message)
    ) {
      const body: any = { ok: false, error: err.message };
      if (err.remaining != null) body.remaining = err.remaining;
      return res.status(status).json(body);
    }
    console.error("holdReservation error:", err);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
}

/** POST /api/bookings/:id/pay-test  (auth) – confirma pago (solo DEV) */
export async function payTestReservation(req: Authed, res: Response) {
  try {
    if (process.env.ALLOW_TEST_PAYMENTS === "false") {
      return res.status(403).json({ ok: false, error: "TEST_PAYMENT_DISABLED" });
    }

    const user = req.user;
    if (!user) return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });

    const id = parseIntSafe(req.params.id);
    if (!id) return res.status(422).json({ ok: false, error: "INVALID_ID" });

    const now = new Date();

    const booking = await prisma.$transaction(async (tx) => {
      const b = await tx.reservation.findUnique({
        where: { id },
        include: { event: { select: { organizerId: true } } },
      });
      if (!b) {
        const e = new Error("BOOKING_NOT_FOUND") as any;
        e.status = 404;
        throw e;
      }

      // Solo el dueño de la reserva o superadmin puede pagarla
      const isSuper = user.role === "superadmin";
      if (!isSuper && b.buyerId !== user.id) {
        const e = new Error("FORBIDDEN_NOT_OWNER") as any;
        e.status = 403;
        throw e;
      }

      // Defensa extra: organizador no puede pagar su propio evento
      if (b.event?.organizerId === user.id && !isSuper) {
        const e = new Error("CANNOT_BUY_OWN_EVENT") as any;
        e.status = 403;
        throw e;
      }

      // Idempotencia y estados no pagables
      if ((b.status as any) === "PAID") return b;
      if ((b.status as any) === "CANCELED") {
        const e = new Error("BOOKING_CANCELED") as any;
        e.status = 409;
        throw e;
      }

      // vencida
      if (b.expiresAt && b.expiresAt <= now) {
        await tx.reservation.update({
          where: { id: b.id },
          data: { status: "EXPIRED" as any },
        });
        const e = new Error("BOOKING_EXPIRED") as any;
        e.status = 409;
        throw e;
      }

      // confirmar pago
      const updated = await tx.reservation.update({
        where: { id: b.id },
        data: { status: "PAID" as any, paidAt: now },
      });
      return updated;
    });

    return res.json({ ok: true, booking });
  } catch (err: any) {
    const status = err?.status ?? 500;
    if (
      [
        "BOOKING_NOT_FOUND",
        "BOOKING_EXPIRED",
        "BOOKING_CANCELED",
        "FORBIDDEN_NOT_OWNER",
        "CANNOT_BUY_OWN_EVENT",
      ].includes(err?.message)
    ) {
      return res.status(status).json({ ok: false, error: err.message });
    }
    console.error("payTestReservation error:", err);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
}

/* ===================== Otros endpoints ===================== */
/** (Opcional/backoffice) POST /api/bookings – compra directa */
export async function createBooking(req: Authed, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Token requerido" });

    const { eventId, quantity } = req.body as { eventId?: number; quantity?: number };
    if (!eventId || !Number.isInteger(eventId)) {
      return res.status(400).json({ error: "eventId inválido" });
    }
    if (!quantity || !Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: "quantity debe ser un entero >= 1" });
    }
    if (quantity > MAX_PER_PURCHASE) {
      return res.status(422).json({ error: `Máximo permitido: ${MAX_PER_PURCHASE}` });
    }

    const created = await prisma.$transaction(async (tx) => {
      const { ev, remaining, hasStarted } = await remainingForEvent(tx, eventId);

      if (hasStarted) {
        const e = new Error("EVENT_HAS_STARTED") as any;
        e.status = 400;
        throw e;
      }
      if (!ev.approved) {
        const e = new Error("EVENT_NOT_APPROVED") as any;
        e.status = 400;
        throw e;
      }
      // 🚫 organizador no puede comprar su propio evento
      if (ev.organizerId === userId) {
        const e = new Error("CANNOT_BUY_OWN_EVENT") as any;
        e.status = 403;
        throw e;
      }

      if (quantity > remaining) {
        const e = new Error("NO_CAPACITY") as any;
        e.status = 409;
        e.remaining = remaining;
        throw e;
      }
      const r = await tx.reservation.create({
        data: {
          eventId,
          buyerId: userId,
          quantity,
          status: "PAID" as any,
          paidAt: new Date(),
          amount: (ev.price ?? 0) * quantity,
        },
        select: { id: true },
      });
      return { id: r.id, remaining: remaining - quantity };
    });

    return res.status(201).json({
      message: "Compra directa creada",
      reservationId: created.id,
      remaining: created.remaining,
    });
  } catch (err: any) {
    const status = err?.status ?? 500;
    if (
      [
        "NO_CAPACITY",
        "EVENT_HAS_STARTED",
        "EVENT_NOT_APPROVED",
        "CANNOT_BUY_OWN_EVENT",
      ].includes(err?.message)
    ) {
      const body: any = { error: err.message };
      if (err.remaining != null) body.remaining = err.remaining;
      return res.status(status).json(body);
    }
    return res.status(500).json({ error: "Error creando reserva", details: err?.message });
  }
}

/** GET /api/bookings/my */
export async function listMyBookings(req: Authed, res: Response) {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Token requerido" });

  const { page = "1", limit = "10" } = req.query as any;
  const p = Math.max(parseInt(String(page), 10) || 1, 1);
  const l = Math.min(Math.max(parseInt(String(limit), 10) || 10, 1), 100);

  const where = { buyerId: userId };

  const [items, total] = await Promise.all([
    prisma.reservation.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (p - 1) * l,
      take: l,
      include: {
        event: { select: { id: true, title: true, date: true, location: true, price: true } },
      },
    }),
    prisma.reservation.count({ where }),
  ]);

  return res.json({ page: p, limit: l, total, items });
}

/** GET /api/bookings/organizer */
export async function listOrganizerBookings(req: Authed, res: Response) {
  const user = req.user;
  if (!user) return res.status(401).json({ error: "Token requerido" });

  const isSuper = user.role === "superadmin";

  const { page = "1", limit = "10", eventId, q } = req.query as any;
  const p = Math.max(parseInt(String(page), 10) || 1, 1);
  const l = Math.min(Math.max(parseInt(String(limit), 10) || 10, 1), 100);

  const where: any = {
    event: isSuper ? {} : { organizerId: user.id },
  };

  if (eventId && Number.isInteger(Number(eventId))) {
    where.eventId = Number(eventId);
  }

  if (q && String(q).trim().length > 0) {
    const or: any[] = [];
    const qStr = String(q).trim();
    const qNum = Number(qStr);
    if (!Number.isNaN(qNum)) or.push({ id: qNum });
    or.push({ event: { title: { contains: qStr, mode: "insensitive" } } });
    if (or.length) where.OR = or;
  }

  const [items, total] = await Promise.all([
    prisma.reservation.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (p - 1) * l,
      take: l,
      include: {
        event: {
          select: { id: true, title: true, date: true, location: true, organizerId: true, price: true },
        },
        buyer: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.reservation.count({ where }),
  ]);

  return res.json({ page: p, limit: l, total, items });
}

/** POST /api/bookings/:id/cancel – marcar como CANCELED (no borrar) */
export async function cancelBooking(req: Authed, res: Response) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: "Token requerido" });

    const id = parseIntSafe(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido" });

    const reservation = await prisma.reservation.findUnique({
      where: { id },
      include: { event: true },
    });
    if (!reservation) return res.status(404).json({ error: "Reserva no encontrada" });

    const isOwner = reservation.buyerId === user.id;
    const isSuper = user.role === "superadmin";
    const isOrganizerOwner =
      user.role === "organizer" && reservation.event.organizerId === user.id;

    if (!isOwner && !isSuper && !isOrganizerOwner) {
      return res.status(403).json({ error: "No autorizado" });
    }

    const updated = await prisma.reservation.update({
      where: { id: reservation.id },
      data: { status: "CANCELED" as any },
    });

    return res.json({ cancelled: true, reservation: updated });
  } catch (err: any) {
    return res.status(500).json({ error: "Error al cancelar", details: err?.message });
  }
}







