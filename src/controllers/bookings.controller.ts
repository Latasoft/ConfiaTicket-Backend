// src/controllers/bookings.controller.ts
import { Request, Response } from "express";
import prisma from "../prisma/client";
import { Prisma } from "@prisma/client";
import { processReservationAfterPayment } from "../services/reservation.service";
import { getTicketLimits } from "../services/config.service";
import crypto from "crypto";

type Authed = Request & { user?: { id: number; role: string; verifiedOrganizer?: boolean } };

const HOLD_MINUTES = 10;

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
      eventType: true,
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
/** 
 * POST /api/bookings/hold (auth) – crea reserva(s) temporal(es)
 * 
 * Body puede ser:
 * - Simple: { eventId, quantity, sectionId?, seats? }
 * - Múltiple: { eventId, sections: [{ sectionId, quantity, seats }] }
 */
export async function holdReservation(req: Authed, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });

    const body = req.body as any;
    const eventId = parseIntSafe(body?.eventId);
    const ticketId = parseIntSafe(body?.ticketId); // Para eventos RESALE
    
    if (!eventId) {
      return res.status(422).json({ ok: false, error: "INVALID_INPUT: eventId required" });
    }

    // Determinar si es compra simple o múltiple
    let sectionsToReserve: Array<{
      sectionId?: number;
      quantity: number;
      seats?: string[];
    }> = [];

    if (body.sections && Array.isArray(body.sections)) {
      // Modo múltiple secciones
      sectionsToReserve = body.sections.map((s: any) => ({
        sectionId: parseIntSafe(s.sectionId),
        quantity: parseIntSafe(s.quantity),
        seats: Array.isArray(s.seats) ? s.seats : undefined,
      }));
    } else {
      // Modo simple (compatibilidad)
      const quantity = parseIntSafe(body.quantity ?? body.qty);
      if (!quantity || quantity < 1) {
        return res.status(422).json({ ok: false, error: "INVALID_INPUT: quantity required" });
      }
      
      sectionsToReserve = [{
        sectionId: parseIntSafe(body.sectionId),
        quantity,
        seats: Array.isArray(body.seats) ? body.seats : undefined,
      }];
    }

    if (sectionsToReserve.length === 0) {
      return res.status(422).json({ ok: false, error: "NO_SECTIONS_TO_RESERVE" });
    }

    const result = await prisma.$transaction(
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
        if (ev.organizerId === userId) {
          const e = new Error("CANNOT_BUY_OWN_EVENT") as any;
          e.status = 403;
          throw e;
        }

        // Validar cantidad total según el tipo de evento
        const totalQuantity = sectionsToReserve.reduce((sum, s) => sum + s.quantity, 0);
        
        // Obtener límites de la configuración
        const ticketLimits = await getTicketLimits();
        const maxAllowed = ticketLimits[ev.eventType]?.MAX || 999999;
        
        if (totalQuantity > maxAllowed) {
          const e = new Error("MAX_PER_PURCHASE_EXCEEDED") as any;
          e.status = 422;
          e.max = maxAllowed;
          e.eventType = ev.eventType;
          throw e;
        }

        if (remaining < totalQuantity) {
          const e = new Error("INSUFFICIENT_STOCK") as any;
          e.status = 409;
          e.remaining = remaining;
          throw e;
        }

        // Validar secciones si el evento es OWN con secciones
        if (ev.eventType === 'OWN') {
          for (const section of sectionsToReserve) {
            if (section.sectionId) {
              // Verificar que la sección existe
              const eventSection = await tx.eventSection.findFirst({
                where: { id: section.sectionId, eventId },
              });

              if (!eventSection) {
                const e = new Error("SECTION_NOT_FOUND") as any;
                e.status = 404;
                e.sectionId = section.sectionId;
                throw e;
              }

              // Validar capacidad de la sección
              const reservedInSection = await tx.reservation.aggregate({
                where: {
                  eventId,
                  sectionId: section.sectionId,
                  status: { in: ['PENDING_PAYMENT', 'PAID'] },
                },
                _sum: { quantity: true },
              });

              const sectionReserved = reservedInSection._sum.quantity || 0;
              const sectionAvailable = eventSection.totalCapacity - sectionReserved;

              if (sectionAvailable < section.quantity) {
                const e = new Error("SECTION_INSUFFICIENT_STOCK") as any;
                e.status = 409;
                e.sectionId = section.sectionId;
                e.sectionName = eventSection.name;
                e.available = sectionAvailable;
                e.requested = section.quantity;
                throw e;
              }

              // Validar asientos específicos si se proporcionaron
              if (section.seats && section.seats.length > 0) {
                if (section.seats.length !== section.quantity) {
                  const e = new Error("SEATS_QUANTITY_MISMATCH") as any;
                  e.status = 422;
                  e.seatsProvided = section.seats.length;
                  e.quantityRequested = section.quantity;
                  throw e;
                }

                // Verificar que los asientos no estén ya reservados
                const existingReservations = await tx.reservation.findMany({
                  where: {
                    eventId,
                    sectionId: section.sectionId,
                    status: { in: ['PENDING_PAYMENT', 'PAID'] },
                    seatAssignment: { not: null },
                  },
                  select: { seatAssignment: true },
                });

                const reservedSeats = new Set<string>();
                existingReservations.forEach(r => {
                  if (r.seatAssignment) {
                    r.seatAssignment.split(',').forEach(seat => {
                      reservedSeats.add(seat.trim());
                    });
                  }
                });

                const conflictingSeats = section.seats.filter(seat => 
                  reservedSeats.has(seat)
                );

                if (conflictingSeats.length > 0) {
                  const e = new Error("SEATS_ALREADY_RESERVED") as any;
                  e.status = 409;
                  e.conflictingSeats = conflictingSeats;
                  throw e;
                }
              }
            }
          }
        }

        // Validar ticket RESALE si se proporcionó ticketId
        if (ticketId) {
          const ticket = await tx.ticket.findFirst({
            where: {
              id: ticketId,
              eventId,
            },
          });

          if (!ticket) {
            const e = new Error("TICKET_NOT_FOUND") as any;
            e.status = 404;
            e.ticketId = ticketId;
            throw e;
          }

          if (ticket.sold || ticket.reservationId) {
            const e = new Error("TICKET_ALREADY_SOLD") as any;
            e.status = 409;
            e.ticketId = ticketId;
            throw e;
          }
        }

        const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60_000);
        const purchaseGroupId = crypto.randomUUID();

        // Crear una reserva por cada sección
        const reservations = [];
        
        for (const section of sectionsToReserve) {
          const amount = (ev.price ?? 0) * section.quantity;
          const seatAssignment = section.seats?.length 
            ? section.seats.join(', ') 
            : undefined;

          const r = await tx.reservation.create({
            data: {
              eventId,
              buyerId: userId,
              quantity: section.quantity,
              sectionId: section.sectionId,
              purchaseGroupId,
              status: "PENDING_PAYMENT" as any,
              expiresAt,
              amount,
              seatAssignment,
            },
            select: { 
              id: true, 
              code: true, 
              quantity: true, 
              amount: true, 
              expiresAt: true,
              sectionId: true,
              seatAssignment: true,
            },
          });

          reservations.push(r);
        }

        // Vincular ticket RESALE a la primera reserva si se proporcionó ticketId
        if (ticketId && reservations.length > 0 && reservations[0]) {
          await tx.ticket.update({
            where: { id: ticketId },
            data: {
              reservationId: reservations[0].id,
            },
          });
        }

        return {
          purchaseGroupId,
          reservations,
          totalAmount: reservations.reduce((sum, r) => sum + r.amount, 0),
          totalQuantity,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    return res.json({ 
      ok: true, 
      purchaseGroupId: result.purchaseGroupId,
      reservations: result.reservations,
      totalAmount: result.totalAmount,
      totalQuantity: result.totalQuantity,
      holdMinutes: HOLD_MINUTES,
      // Compatibilidad con frontend antiguo
      booking: result.reservations[0],
    });
  } catch (err: any) {
    const status = err?.status ?? 500;
    if (
      [
        "EVENT_NOT_FOUND",
        "INSUFFICIENT_STOCK",
        "EVENT_HAS_STARTED",
        "EVENT_NOT_APPROVED",
        "CANNOT_BUY_OWN_EVENT",
        "SECTION_NOT_FOUND",
        "SECTION_INSUFFICIENT_STOCK",
        "SEATS_ALREADY_RESERVED",
        "SEATS_QUANTITY_MISMATCH",
      ].includes(err?.message)
    ) {
      const body: any = { ok: false, error: err.message };
      if (err.remaining != null) body.remaining = err.remaining;
      if (err.sectionId != null) body.sectionId = err.sectionId;
      if (err.sectionName != null) body.sectionName = err.sectionName;
      if (err.available != null) body.available = err.available;
      if (err.requested != null) body.requested = err.requested;
      if (err.conflictingSeats != null) body.conflictingSeats = err.conflictingSeats;
      if (err.seatsProvided != null) body.seatsProvided = err.seatsProvided;
      if (err.quantityRequested != null) body.quantityRequested = err.quantityRequested;
      return res.status(status).json(body);
    }
    console.error("holdReservation error:", err);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
}

/** 
 * POST /api/bookings/:id/pay-test (auth) – confirma pago (solo DEV)
 * Si la reserva tiene purchaseGroupId, paga todas las reservas del grupo
 */
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

    const result = await prisma.$transaction(async (tx) => {
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

      // Si tiene purchaseGroupId, obtener todas las reservas del grupo
      const reservationsToPay = b.purchaseGroupId
        ? await tx.reservation.findMany({
            where: { purchaseGroupId: b.purchaseGroupId },
          })
        : [b];

      // Validar que todas estén en estado pagable
      for (const reservation of reservationsToPay) {
        if ((reservation.status as any) === "CANCELED") {
          const e = new Error("BOOKING_CANCELED") as any;
          e.status = 409;
          throw e;
        }

        if (reservation.expiresAt && reservation.expiresAt <= now) {
          await tx.reservation.update({
            where: { id: reservation.id },
            data: { status: "EXPIRED" as any },
          });
          const e = new Error("BOOKING_EXPIRED") as any;
          e.status = 409;
          throw e;
        }
      }

      // Marcar todas como PAID
      const updatedReservations = [];
      for (const reservation of reservationsToPay) {
        if ((reservation.status as any) !== "PAID") {
          const updated = await tx.reservation.update({
            where: { id: reservation.id },
            data: { status: "PAID" as any, paidAt: now },
          });
          updatedReservations.push(updated);
        } else {
          updatedReservations.push(reservation);
        }
      }

      return {
        reservations: updatedReservations,
        purchaseGroupId: b.purchaseGroupId,
      };
    });

    // Procesar cada reserva FUERA de la transacción para evitar timeout
    // (generar PDFs individuales para OWN, marcar vendido para RESALE)
    const processedReservations = [];
    for (const reservation of result.reservations) {
      try {
        await processReservationAfterPayment(reservation.id);
        processedReservations.push(reservation);
      } catch (pdfError) {
        console.error(`Error procesando reserva ${reservation.id} después del pago:`, pdfError);
        // No fallar la respuesta, el pago ya se confirmó
        processedReservations.push(reservation);
      }
    }

    return res.json({ 
      ok: true, 
      reservations: processedReservations,
      purchaseGroupId: result.purchaseGroupId,
      totalAmount: processedReservations.reduce((sum, r) => sum + r.amount, 0),
      // Compatibilidad con frontend antiguo
      booking: processedReservations[0],
    });
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

/** GET /api/bookings/:id */
export async function getBooking(req: Authed, res: Response) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: "Token requerido" });

    const id = parseIntSafe(req.params.id);
    if (!id) return res.status(422).json({ error: "ID inválido" });

    const reservation = await prisma.reservation.findUnique({
      where: { id },
      include: {
        event: {
          select: {
            id: true,
            title: true,
            date: true,
            location: true,
            city: true,
            commune: true,
            price: true,
            eventType: true,
            organizerId: true,
          },
        },
        buyer: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    if (!reservation) {
      return res.status(404).json({ error: "Reserva no encontrada" });
    }

    // Solo el dueño, el organizador del evento o superadmin pueden ver
    const isOwner = reservation.buyerId === user.id;
    const isSuper = user.role === "superadmin";
    const isOrganizerOwner =
      user.role === "organizer" && reservation.event.organizerId === user.id;

    if (!isOwner && !isSuper && !isOrganizerOwner) {
      return res.status(403).json({ error: "No autorizado" });
    }

    return res.json(reservation);
  } catch (err: any) {
    console.error("getBooking error:", err);
    return res.status(500).json({ error: "Error al obtener reserva" });
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

    // Liberar tickets RESALE si los hay
    await prisma.ticket.updateMany({
      where: { reservationId: reservation.id },
      data: { reservationId: null }
    });

    const updated = await prisma.reservation.update({
      where: { id: reservation.id },
      data: { status: "CANCELED" as any },
    });

    return res.json({ cancelled: true, reservation: updated });
  } catch (err: any) {
    return res.status(500).json({ error: "Error al cancelar", details: err?.message });
  }
}

/* ===================== Descargar Ticket PDF ===================== */
export async function downloadTicket(req: Authed, res: Response) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: "UNAUTHENTICATED" });

    const id = parseIntSafe(req.params.id);
    if (!id) return res.status(422).json({ error: "INVALID_ID" });

    const reservation = await prisma.reservation.findUnique({
      where: { id },
      include: {
        event: { select: { organizerId: true, eventType: true } },
      },
    });

    if (!reservation) {
      return res.status(404).json({ error: "BOOKING_NOT_FOUND" });
    }

    // Solo el dueño de la reserva o superadmin pueden descargar
    const isSuper = user.role === "superadmin";
    if (!isSuper && reservation.buyerId !== user.id) {
      return res.status(403).json({ error: "FORBIDDEN_NOT_OWNER" });
    }

    // Solo reservas pagadas tienen PDF
    if (reservation.status !== "PAID") {
      return res.status(400).json({ error: "BOOKING_NOT_PAID" });
    }

    // Verificar que existe PDF generado (ahora tanto OWN como RESALE tienen PDFs)
    if (!reservation.generatedPdfPath) {
      return res.status(404).json({ error: "PDF_NOT_GENERATED_YET" });
    }

    // Enviar el archivo PDF
    const fs = require('fs');
    const path = require('path');
    const pdfPath = path.resolve(reservation.generatedPdfPath);

    if (!fs.existsSync(pdfPath)) {
      return res.status(404).json({ error: "PDF_FILE_NOT_FOUND" });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ticket-${reservation.code}.pdf"`);
    
    const fileStream = fs.createReadStream(pdfPath);
    fileStream.pipe(res);
  } catch (err: any) {
    console.error("downloadTicket error:", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
}/* ===================== Tickets Individuales (OWN) ===================== */

/** GET /api/bookings/:id/tickets - Lista todos los tickets generados de una reserva */
export async function listReservationTickets(req: Authed, res: Response) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: "UNAUTHENTICATED" });

    const id = parseIntSafe(req.params.id);
    if (!id) return res.status(422).json({ error: "INVALID_ID" });

    const reservation = await prisma.reservation.findUnique({
      where: { id },
      include: {
        event: { select: { title: true, date: true, location: true, eventType: true } },
        generatedTickets: {
          orderBy: { ticketNumber: 'asc' },
        },
      },
    });

    if (!reservation) {
      return res.status(404).json({ error: "BOOKING_NOT_FOUND" });
    }

    // Solo el dueño o superadmin
    const isSuper = user.role === "superadmin";
    if (!isSuper && reservation.buyerId !== user.id) {
      return res.status(403).json({ error: "FORBIDDEN_NOT_OWNER" });
    }

    if (reservation.status !== "PAID") {
      return res.status(400).json({ error: "BOOKING_NOT_PAID" });
    }

    return res.json({
      reservation: {
        id: reservation.id,
        code: reservation.code,
        status: reservation.status,
        quantity: reservation.quantity,
        amount: reservation.amount,
        paidAt: reservation.paidAt,
        event: reservation.event,
      },
      tickets: reservation.generatedTickets.map(t => ({
        id: t.id,
        ticketNumber: t.ticketNumber,
        seatNumber: t.seatNumber,
        qrCode: t.qrCode,
        scanned: t.scanned,
        scannedAt: t.scannedAt,
      })),
    });
  } catch (err: any) {
    console.error("listReservationTickets error:", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
}

/** GET /api/bookings/:id/tickets/:ticketId/download - Descarga un ticket individual */
export async function downloadIndividualTicket(req: Authed, res: Response) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: "UNAUTHENTICATED" });

    const reservationId = parseIntSafe(req.params.id);
    const ticketId = parseIntSafe(req.params.ticketId);
    
    if (!reservationId || !ticketId) {
      return res.status(422).json({ error: "INVALID_ID" });
    }

    const ticket = await prisma.generatedTicket.findFirst({
      where: {
        id: ticketId,
        reservationId,
      },
      include: {
        reservation: {
          select: {
            buyerId: true,
            status: true,
            code: true,
            event: { select: { eventType: true } },
          },
        },
      },
    });

    if (!ticket) {
      return res.status(404).json({ error: "TICKET_NOT_FOUND" });
    }

    // Solo el dueño o superadmin
    const isSuper = user.role === "superadmin";
    if (!isSuper && ticket.reservation.buyerId !== user.id) {
      return res.status(403).json({ error: "FORBIDDEN_NOT_OWNER" });
    }

    if (ticket.reservation.status !== "PAID") {
      return res.status(400).json({ error: "BOOKING_NOT_PAID" });
    }

    // Enviar el archivo PDF
    const fs = require('fs');
    const path = require('path');
    const pdfPath = path.resolve(ticket.pdfPath);

    if (!fs.existsSync(pdfPath)) {
      return res.status(404).json({ error: "PDF_FILE_NOT_FOUND" });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ticket-${ticket.reservation.code}-${ticket.ticketNumber}.pdf"`);
    
    const fileStream = fs.createReadStream(pdfPath);
    fileStream.pipe(res);
  } catch (err: any) {
    console.error("downloadIndividualTicket error:", err);
    return res.status(500).json({ error: "SERVER_ERROR" });
  }
}




