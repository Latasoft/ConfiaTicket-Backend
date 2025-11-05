import { Request, Response } from 'express';
import prisma from '../prisma/client';
import { getTicketLimits } from '../services/config.service';

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

/* ======== Ventana de HOLD para bloquear stock (por defecto 15 min) ======== */
const HOLD_MINUTES = Number(process.env.HOLD_MINUTES ?? process.env.BOOKING_HOLD_MINUTES ?? 15);
const HOLD_MS = HOLD_MINUTES * 60_000;

/* ================= Helpers de parseo ================= */
function parseIntSafe(val: unknown, def: number): number {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}
function parseBool(val: unknown, def = false): boolean {
  const v = String(val ?? '').trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return def;
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
    if (!Number.isInteger(capacityNumber) || capacityNumber < 1) {
      return res.status(400).json({ error: 'La capacidad debe ser un número entero mayor a 0.' });
    }

    // Validar límites de capacidad según configuración (RESALE )
    // Endpoint legacy para eventos RESALE
    // Para eventos OWN, usar el endpoint de organizer.events.controller.ts
    const ticketLimits = await getTicketLimits();
    const maxCapacityResale = ticketLimits.RESALE?.MAX || 4;
    
    if (capacityNumber > maxCapacityResale) {
      return res.status(400).json({ 
        error: `La capacidad no puede exceder ${maxCapacityResale} tickets para eventos de reventa.`,
        maxCapacity: maxCapacityResale
      });
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

    let organizerId = auth?.id ?? 0;
    if (auth?.role === 'superadmin') {
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

    const includePast =
      parseBool(req.query.includePast, false) ||
      parseBool((req.query as any).showPast, false);
    const includeSoldOut = parseBool(req.query.includeSoldOut, false);

    const q = (req.query.q as string | undefined)?.trim();
    const location = (req.query.location as string | undefined)?.trim();
    const dateFrom = req.query.dateFrom as string | undefined;
    const dateTo = req.query.dateTo as string | undefined;

    const now = new Date();

    const whereCommon: any = { approved: true };
    if (q) {
      const contains: any = { contains: q };
      whereCommon.OR = [{ title: contains }, { description: contains }, { location: contains }];
    }
    if (location) {
      whereCommon.location = { contains: location } as any;
    }

    /* ===== Caso combinado: includePast && includeSoldOut ===== */
    if (includePast && includeSoldOut) {
      const pastWhere = { ...whereCommon, date: { lt: now } };
      const futureWhere = { ...whereCommon, date: { gte: now } };
      const BASE_CAP = Math.min(Math.max(limit * 10, 100), 1000);

      const [pastList, futureList] = await Promise.all([
        prisma.event.findMany({
          where: pastWhere,
          orderBy: { [orderBy]: orderDir },
          take: BASE_CAP,
          select: {
            id: true, title: true, description: true, date: true, location: true,
            capacity: true, price: true, organizerId: true, approved: true,
            createdAt: true, coverImageUrl: true, eventType: true,
          },
        }),
        prisma.event.findMany({
          where: futureWhere,
          orderBy: { [orderBy]: orderDir },
          take: BASE_CAP,
          select: {
            id: true, title: true, description: true, date: true, location: true,
            capacity: true, price: true, organizerId: true, approved: true,
            createdAt: true, coverImageUrl: true, eventType: true,
          },
        }),
      ]);

      let futureSoldOut: typeof futureList = [];
      if (futureList.length) {
        const ids = futureList.map(e => e.id);

        const agg = await prisma.reservation.groupBy({
          by: ['eventId'],
          _sum: { quantity: true },
          where: {
            eventId: { in: ids },
            OR: [
              { status: 'PAID' as any },
              {
                status: 'PENDING_PAYMENT' as any,
                expiresAt: { gt: now },
                createdAt: { gt: new Date(now.getTime() - HOLD_MS) },
              },
            ],
          },
        });
        const soldMap = new Map<number, number>(agg.map(g => [g.eventId as number, g._sum.quantity ?? 0]));

        futureSoldOut = futureList.filter(ev => {
          const sold = soldMap.get(ev.id) ?? 0;
          const remaining = Math.max(0, ev.capacity - sold);
          const salesClosed = now >= getSalesCloseAt(ev.date as Date);
          return remaining <= 0 || salesClosed;
        });
      }

      const merged = [...pastList, ...futureSoldOut];
      merged.sort((a: any, b: any) => {
        const va = a[orderBy], vb = b[orderBy];
        let cmp = 0;
        if (orderBy === 'title' || orderBy === 'location') {
          cmp = String(va ?? '').localeCompare(String(vb ?? ''), 'es');
        } else if (orderBy === 'date' || orderBy === 'createdAt') {
          cmp = new Date(va).getTime() - new Date(vb).getTime();
        } else {
          cmp = Number(va ?? 0) - Number(vb ?? 0);
        }
        return orderDir === 'desc' ? -cmp : cmp;
      });

      const total = merged.length;
      const start = (page - 1) * limit;
      const events = merged.slice(start, start + limit);
      return res.json({ page, limit, total, pages: Math.ceil(total / limit), events });
    }
    /* =================== FIN caso combinado =================== */

    const where: any = { ...whereCommon };

    if (dateFrom || dateTo) {
      where.date = where.date || {};
      if (dateFrom) {
        const d = new Date(dateFrom);
        if (!Number.isNaN(d.getTime())) where.date.gte = d;
      }
      if (dateTo) {
        const d = new Date(dateTo);
        if (!Number.isNaN(d.getTime())) where.date.lte = d;
      }
    }
    if (!includePast) {
      where.date = where.date || {};
      where.date.gte = now;
    }

    const BASE_CAP = Math.min(Math.max(limit * 10, 100), 1000);
    const baseList = await prisma.event.findMany({
      where,
      orderBy: { [orderBy]: orderDir },
      take: BASE_CAP,
      select: {
        id: true, title: true, description: true, date: true, location: true,
        capacity: true, price: true, organizerId: true, approved: true,
        createdAt: true, coverImageUrl: true, eventType: true,
      },
    });

    if (includeSoldOut) {
      const total = baseList.length;
      const start = (page - 1) * limit;
      const events = baseList.slice(start, start + limit);
      return res.json({ page, limit, total, pages: Math.ceil(total / limit), events });
    }

    const ids = baseList.map(e => e.id);
    let filtered = baseList;

    if (ids.length) {
      const paidGroups = await prisma.reservation.groupBy({
        by: ['eventId'],
        _sum: { quantity: true },
        where: {
          eventId: { in: ids },
          status: 'PAID' as any,
        },
      });
      const paidMap = new Map<number, number>(
        paidGroups.map(g => [g.eventId as number, g._sum.quantity ?? 0])
      );

      filtered = baseList.filter(ev => {
        const paid = paidMap.get(ev.id) ?? 0;
        const remainingPaidOnly = Math.max(0, ev.capacity - paid);
        const salesClosed = now >= getSalesCloseAt(ev.date as Date);
        return remainingPaidOnly > 0 && !salesClosed;
      });
    }

    const total = filtered.length;
    const start = (page - 1) * limit;
    const events = filtered.slice(start, start + limit);
    return res.json({ page, limit, total, pages: Math.ceil(total / limit), events });
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
      const contains: any = { contains: q };
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
          eventType: true,
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
        eventType: true,
      },
    });

    return res.json(events);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Error al obtener eventos pendientes' });
  }
}

/* ============= Detalle público ============= */
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
        eventType: true,
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

    // Determinar la capacidad real del evento
    let totalCapacity = event.capacity;
    
    // Si el evento tiene secciones, usar la suma de capacidades de las secciones
    if (event.eventType === 'OWN') {
      const sections = await prisma.eventSection.findMany({
        where: { eventId },
        select: { totalCapacity: true },
      });
      
      if (sections.length > 0) {
        totalCapacity = sections.reduce((sum, section) => sum + section.totalCapacity, 0);
      }
    }

    // Ventas pagadas vs reservas activas (pendientes dentro del HOLD)
    const [paidAgg, pendingAgg] = await Promise.all([
      prisma.reservation.aggregate({
        _sum: { quantity: true },
        where: { eventId, status: 'PAID' as any },
      }),
      prisma.reservation.aggregate({
        _sum: { quantity: true },
        where: {
          eventId,
          status: 'PENDING_PAYMENT' as any,
          expiresAt: { gt: now },
          createdAt: { gt: new Date(now.getTime() - HOLD_MS) }, // solo ventana de hold
        },
      }),
    ]);

    const paid = paidAgg._sum.quantity ?? 0;
    const pendingActive = pendingAgg._sum.quantity ?? 0;

    const remainingPaidOnly = Math.max(0, totalCapacity - paid);
    const remaining = Math.max(0, totalCapacity - (paid + pendingActive));

    const hasStarted = now >= startsAt;
    const canBuy = event.approved && !hasStarted && !salesClosed && remaining > 0;

    return res.json({
      ...event,
      capacity: totalCapacity, // Capacidad real (suma de secciones si existen)
      remaining,
      remainingPaidOnly,
      pendingActive,
      hasStarted,
      canBuy,
      salesClosed,
      salesCloseAt: salesCloseAt.toISOString(),
      startsAt: startsAt.toISOString(),
      salesCutoffMinutes: SALES_CUTOFF_MINUTES,
      holdMinutes: HOLD_MINUTES,
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

      const closeAt = getSalesCloseAt(startsAt);
      if (now >= closeAt) {
        return {
          status: 400,
          payload: { error: `Las ventas se cierran ${cutoffLabel(SALES_CUTOFF_MINUTES)} antes del inicio.` },
        };
      }

      if (now >= startsAt) {
        return { status: 400, payload: { error: 'El evento ya comenzó. No se pueden comprar entradas.' } };
      }

      if (ev.organizerId === auth.id) {
        return { status: 403, payload: { error: 'No puedes comprar entradas de tu propio evento.' } };
      }

      // Stock: PAID + PENDING dentro de la ventana de HOLD
      const soldAgg = await tx.reservation.aggregate({
        _sum: { quantity: true },
        where: {
          eventId,
          OR: [
            { status: 'PAID' as any },
            {
              status: 'PENDING_PAYMENT' as any,
              expiresAt: { gt: now },
              createdAt: { gt: new Date(now.getTime() - HOLD_MS) },
            },
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



















