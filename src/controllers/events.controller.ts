// src/controllers/events.controller.ts
import { Request, Response } from 'express';
import prisma from '../prisma/client';

/* ============ Config de cierre de ventas (por defecto 24 h) ============ */
const SALES_CUTOFF_MINUTES = Number(process.env.SALES_CUTOFF_MINUTES ?? 1440);
function getSalesCloseAt(startsAt: Date): Date {
  return new Date(startsAt.getTime() - SALES_CUTOFF_MINUTES * 60_000);
}
function cutoffLabel(min: number): string {
  if (min % 1440 === 0) {
    const d = min / 1440;
    return `${d} día${d > 1 ? 's' : ''}`;
  }
  if (min % 60 === 0) {
    const h = min / 60;
    return `${h} hora${h > 1 ? 's' : ''}`;
  }
  return `${min} minuto${min > 1 ? 's' : ''}`;
}

/* ================= Helpers de parseo ================= */
function parseIntSafe(val: unknown, def: number): number {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

const ALLOWED_ORDER_FIELDS = new Set([
  'date',
  'createdAt',
  'title',
  'location',
  'capacity',
  'price',
]);
function parseOrderBy(val: unknown): string {
  const v = String(val || '').trim();
  return ALLOWED_ORDER_FIELDS.has(v) ? v : 'date';
}
function parseOrderDir(val: unknown): 'asc' | 'desc' {
  const v = String(val || '').toLowerCase();
  return v === 'desc' ? 'desc' : 'asc';
}

/* ================= Crear evento ================= */
export async function createEvent(req: Request, res: Response) {
  try {
    const auth = (req as any).user as { id: number; role: string };

    const {
      title,
      description,
      date,
      location,
      capacity,
      price,
      organizerId: bodyOrganizerId,
      coverImageUrl,
    } = req.body;

    if (
      title == null ||
      description == null ||
      date == null ||
      location == null ||
      capacity == null ||
      price == null
    ) {
      return res.status(400).json({ error: 'Faltan datos requeridos (title, description, date, location, capacity, price)' });
    }

    const capacityNumber = Number(capacity);
    if (!Number.isInteger(capacityNumber) || capacityNumber < 1 || capacityNumber > 4) {
      return res.status(400).json({ error: 'La capacidad debe ser un entero entre 1 y 4.' });
    }

    const priceNumber = Number(price);
    if (!Number.isInteger(priceNumber) || priceNumber < 0) {
      return res.status(400).json({ error: 'El precio debe ser un entero en pesos chilenos (>= 0).' });
    }
    if (priceNumber > 50_000_000) {
      return res.status(400).json({ error: 'Precio demasiado alto.' });
    }

    const parsedDate = new Date(date);
    if (Number.isNaN(parsedDate.getTime())) {
      return res.status(400).json({ error: 'Fecha inválida (use ISO 8601 o formato válido)' });
    }

    let organizerId = auth.id;
    if (auth.role === 'superadmin') {
      const oId = Number(bodyOrganizerId);
      if (!Number.isInteger(oId) || oId <= 0) {
        return res.status(400).json({ error: 'Para superadmin, organizerId es requerido y debe ser numérico' });
      }
      const organizer = await prisma.user.findUnique({
        where: { id: oId },
        select: { id: true, role: true },
      });
      if (!organizer || organizer.role !== 'organizer') {
        return res.status(404).json({ error: 'Organizer destino no encontrado' });
      }
      organizerId = oId;
    }

    const event = await prisma.event.create({
      data: {
        title,
        description,
        date: parsedDate,
        location,
        capacity: capacityNumber,
        price: priceNumber,
        organizerId,
        ...(coverImageUrl ? { coverImageUrl: String(coverImageUrl) } : {}),
      },
    });

    return res.status(201).json(event);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Error creando evento' });
  }
}

/* ================= Aprobar / rechazar ================= */
export async function approveEvent(req: Request, res: Response) {
  try {
    const eventId = Number(req.params.id);
    const { approved } = req.body as { approved?: boolean };

    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({ error: 'ID de evento inválido' });
    }
    if (typeof approved !== 'boolean') {
      return res.status(400).json({ error: 'El campo approved debe ser booleano' });
    }

    const existing = await prisma.event.findUnique({ where: { id: eventId } });
    if (!existing) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    const event = await prisma.event.update({
      where: { id: eventId },
      data: { approved },
    });

    return res.json(event);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Error actualizando evento' });
  }
}

/* ============= Listar eventos públicos (aprobados) ============= */
export async function listPublicEvents(req: Request, res: Response) {
  try {
    const page = parseIntSafe(req.query.page, 1);
    const limit = parseIntSafe(req.query.limit, 10);
    const orderBy = parseOrderBy(req.query.orderBy);
    const orderDir = parseOrderDir(req.query.orderDir);

    const q = (req.query.q as string | undefined)?.trim();
    const location = (req.query.location as string | undefined)?.trim();
    const dateFrom = req.query.dateFrom as string | undefined;
    const dateTo = req.query.dateTo as string | undefined;

    const where: any = { approved: true };

    if (q) {
      const contains = { contains: q };
      where.OR = [
        { title: contains },
        { description: contains },
        { location: contains },
      ];
    }

    if (location) {
      where.location = { contains: location };
    }

    if (dateFrom || dateTo) {
      where.date = {};
      if (dateFrom) {
        const d = new Date(dateFrom);
        if (!Number.isNaN(d.getTime())) where.date.gte = d;
      }
      if (dateTo) {
        const d = new Date(dateTo);
        if (!Number.isNaN(d.getTime())) where.date.lte = d;
      }
    }

    const [events, total] = await Promise.all([
      prisma.event.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { [orderBy]: orderDir },
        select: {
          id: true,
          title: true,
          description: true,
          date: true,
          location: true,
          capacity: true,
          price: true,
          organizerId: true,
          approved: true,
          createdAt: true,
          coverImageUrl: true,
        },
      }),
      prisma.event.count({ where }),
    ]);

    return res.json({
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      events,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Error al obtener eventos públicos' });
  }
}

/* ====== Listar eventos del organizador logueado ====== */
export async function listOrganizerEvents(req: Request, res: Response) {
  try {
    const organizerId = Number((req as any).user.id);

    const page = parseIntSafe(req.query.page, 1);
    const limit = parseIntSafe(req.query.limit, 10);
    const orderBy = parseOrderBy(req.query.orderBy);
    const orderDir = parseOrderDir(req.query.orderDir);

    const q = (req.query.q as string | undefined)?.trim();
    const dateFrom = req.query.dateFrom as string | undefined;
    const dateTo = req.query.dateTo as string | undefined;

    const where: any = { organizerId };

    if (q) {
      const contains = { contains: q };
      where.OR = [
        { title: contains },
        { description: contains },
        { location: contains },
      ];
    }

    if (dateFrom || dateTo) {
      where.date = {};
      if (dateFrom) {
        const d = new Date(dateFrom);
        if (!Number.isNaN(d.getTime())) where.date.gte = d;
      }
      if (dateTo) {
        const d = new Date(dateTo);
        if (!Number.isNaN(d.getTime())) where.date.lte = d;
      }
    }

    const [events, total] = await Promise.all([
      prisma.event.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { [orderBy]: orderDir },
        select: {
          id: true,
          title: true,
          description: true,
          date: true,
          location: true,
          capacity: true,
          price: true,
          approved: true,
          createdAt: true,
          coverImageUrl: true,
        },
      }),
      prisma.event.count({ where }),
    ]);

    return res.json({
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      events,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Error al obtener eventos del organizador' });
  }
}

/* ============= Listar eventos pendientes (admin) ============= */
export async function listPendingEvents(_req: Request, res: Response) {
  try {
    const events = await prisma.event.findMany({
      where: { approved: false },
      orderBy: { date: 'asc' },
      select: {
        id: true,
        title: true,
        description: true,
        date: true,
        location: true,
        capacity: true,
        price: true,
        organizerId: true,
        approved: true,
        coverImageUrl: true,
      },
    });

    return res.json(events);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Error al obtener eventos pendientes' });
  }
}

/* ============= Detalle público (incluye remaining + flags + precio) ============= */
export async function getEventDetails(req: Request, res: Response) {
  try {
    const eventId = Number(req.params.id);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({ error: 'ID de evento inválido' });
    }

    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        title: true,
        description: true,
        date: true,
        location: true,
        capacity: true,
        price: true,
        approved: true,
        coverImageUrl: true,
        organizerId: true,
        organizer: { select: { id: true, name: true, email: true } },
      },
    });

    if (!event) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    const now = new Date();
    const startsAt = event.date instanceof Date ? event.date : new Date(event.date);
    const salesCloseAt = getSalesCloseAt(startsAt);
    const salesClosed = now >= salesCloseAt;

    // Entradas ocupadas = pagadas + holds activos (no vencidos)
    const soldAgg = await prisma.reservation.aggregate({
      _sum: { quantity: true },
      where: {
        eventId,
        OR: [
          { status: 'PAID' as any },
          { status: 'PENDING_PAYMENT' as any, expiresAt: { gt: now } },
        ],
      },
    });
    const sold = soldAgg._sum.quantity ?? 0;
    const remaining = Math.max(0, event.capacity - sold);

    // Flags para front
    const hasStarted = now >= startsAt;
    const canBuy = event.approved && !hasStarted && !salesClosed && remaining > 0;

    return res.json({
      ...event,
      remaining,
      hasStarted,
      canBuy,
      salesClosed,
      salesCloseAt: salesCloseAt.toISOString(),
      startsAt: startsAt.toISOString(),
      salesCutoffMinutes: SALES_CUTOFF_MINUTES,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Error al obtener detalles del evento' });
  }
}

/* ================= Comprar entradas (directa) ================= */
export async function purchaseTickets(req: Request, res: Response) {
  const auth = (req as any).user as { id: number; role: string } | undefined;
  if (!auth) return res.status(401).json({ error: 'No autenticado' });

  const eventId = Number(req.params.id);
  const qty = Number((req.body as any)?.quantity);

  if (!Number.isInteger(eventId) || eventId <= 0) {
    return res.status(400).json({ error: 'ID de evento inválido' });
  }
  if (!Number.isInteger(qty) || qty < 1 || qty > 4) {
    return res.status(400).json({ error: 'La cantidad debe estar entre 1 y 4.' });
  }

  try {
    const txResult = await prisma.$transaction(async (tx) => {
      const ev = await tx.event.findUnique({
        where: { id: eventId },
        select: { id: true, capacity: true, price: true, organizerId: true, approved: true, date: true },
      });
      if (!ev) return { status: 404, payload: { error: 'Evento no encontrado' } };

      const now = new Date();
      const startsAt = ev.date instanceof Date ? ev.date : new Date(ev.date);

      // Cierre por cutoff (p. ej., 24 h antes)
      const closeAt = getSalesCloseAt(startsAt);
      if (now >= closeAt) {
        return {
          status: 400,
          payload: { error: `Las ventas se cierran ${cutoffLabel(SALES_CUTOFF_MINUTES)} antes del inicio.` },
        };
      }

      // Bloquear si el evento ya comenzó (por si cutoff = 0)
      if (now >= startsAt) {
        return { status: 400, payload: { error: 'El evento ya comenzó. No se pueden comprar entradas.' } };
      }

      if (ev.organizerId === auth.id) {
        return { status: 403, payload: { error: 'No puedes comprar entradas de tu propio evento.' } };
      }

      // Stock: PAID + holds activos
      const soldAgg = await tx.reservation.aggregate({
        _sum: { quantity: true },
        where: {
          eventId,
          OR: [
            { status: 'PAID' as any },
            { status: 'PENDING_PAYMENT' as any, expiresAt: { gt: now } },
          ],
        },
      });
      const sold = soldAgg._sum.quantity ?? 0;
      const remaining = ev.capacity - sold;

      if (remaining <= 0) {
        return { status: 409, payload: { error: 'No quedan entradas disponibles.' } };
      }
      if (qty > remaining) {
        return { status: 409, payload: { error: `Solo quedan ${remaining} entradas.` } };
      }

      const amount = (ev.price ?? 0) * qty;

      const reservation = await tx.reservation.create({
        data: {
          eventId: ev.id,
          buyerId: auth.id,
          quantity: qty,
          status: 'PAID' as any,
          paidAt: now,
          amount,
        },
        select: { id: true, eventId: true, buyerId: true, quantity: true, createdAt: true, amount: true },
      });

      return { status: 201, payload: { message: 'Compra directa creada', reservation } };
    });

    return res.status(txResult.status).json(txResult.payload);
  } catch (e) {
    console.error('purchaseTickets error:', e);
    return res.status(500).json({ error: 'No se pudo procesar la compra' });
  }
}

/* ================= Editar evento ================= */
export async function updateEvent(req: Request, res: Response) {
  try {
    const eventId = Number(req.params.id);
    const organizerId = Number((req as any).user.id);
    const { title, description, date, location, capacity, price, coverImageUrl } = req.body;

    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({ error: 'ID de evento inválido' });
    }

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });
    if (event.organizerId !== organizerId) {
      return res.status(403).json({ error: 'No autorizado para modificar este evento' });
    }
    if (event.approved) {
      return res.status(400).json({ error: 'No se puede modificar un evento aprobado' });
    }

    if (
      title == null || description == null || date == null ||
      location == null || capacity == null || price == null
    ) {
      return res.status(400).json({ error: 'Faltan datos requeridos' });
    }

    const capacityNumber = Number(capacity);
    if (!Number.isInteger(capacityNumber) || capacityNumber < 1 || capacityNumber > 4) {
      return res.status(400).json({ error: 'La capacidad debe ser un entero entre 1 y 4.' });
    }

    const priceNumber = Number(price);
    if (!Number.isInteger(priceNumber) || priceNumber < 0) {
      return res.status(400).json({ error: 'El precio debe ser un entero en pesos chilenos (>= 0).' });
    }
    if (priceNumber > 50_000_000) {
      return res.status(400).json({ error: 'Precio demasiado alto.' });
    }

    const parsedDate = new Date(date);
    if (Number.isNaN(parsedDate.getTime())) {
      return res.status(400).json({ error: 'Fecha inválida' });
    }

    const updatedEvent = await prisma.event.update({
      where: { id: eventId },
      data: {
        title,
        description,
        date: parsedDate,
        location,
        capacity: capacityNumber,
        price: priceNumber,
        ...(coverImageUrl !== undefined ? { coverImageUrl: String(coverImageUrl) } : {}),
      },
    });

    return res.json(updatedEvent);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Error actualizando evento' });
  }
}

/* ================ Eliminar evento (dueño, no aprobado) ================ */
export async function deleteEvent(req: Request, res: Response) {
  try {
    const eventId = Number(req.params.id);
    const organizerId = Number((req as any).user.id);

    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({ error: 'ID de evento inválido' });
    }

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });
    if (event.organizerId !== organizerId) {
      return res.status(403).json({ error: 'No autorizado para eliminar este evento' });
    }
    if (event.approved) {
      return res.status(400).json({ error: 'No se puede eliminar un evento aprobado' });
    }

    await prisma.event.delete({ where: { id: eventId } });
    return res.json({ message: 'Evento eliminado correctamente' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Error eliminando evento' });
  }
}















