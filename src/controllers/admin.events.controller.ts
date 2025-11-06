// src/controllers/admin.events.controller.ts
import { Request, Response } from 'express';
import prisma from '../prisma/client';

type AdminStatus = 'approved' | 'pending';
const ALLOWED: Set<AdminStatus> = new Set(['approved', 'pending']);

function toInt(v: unknown, d: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
}
function toStr(v: unknown) {
  return String(v ?? '').trim();
}

// Mapea Event (DB) -> DTO para frontend admin
function mapEvent(ev: any) {
  const organizerDeletedOrInactive =
    !ev.organizer?.isActive || Boolean(ev.organizer?.deletedAt);

  return {
    id: ev.id,
    title: ev.title,
    description: ev.description,

    // fechas principales
    startAt:
      ev?.date
        ? (ev.date instanceof Date ? ev.date.toISOString() : new Date(ev.date).toISOString())
        : null,
    createdAt:
      ev?.createdAt
        ? (ev.createdAt instanceof Date
            ? ev.createdAt.toISOString()
            : new Date(ev.createdAt).toISOString())
        : null,
    updatedAt:
      ev?.updatedAt
        ? (ev.updatedAt instanceof Date
            ? ev.updatedAt.toISOString()
            : new Date(ev.updatedAt).toISOString())
        : null,

    // otros campos
    venue: ev.location,
    capacity: ev.capacity,
    status: ev.approved ? ('approved' as AdminStatus) : ('pending' as AdminStatus),
    isActive: ev.isActive ?? true,
    eventType: ev.eventType,
    organizerId: ev.organizerId,
    organizer: ev.organizer
      ? {
          id: ev.organizer.id,
          name: ev.organizer.name,
          email: ev.organizer.email,
          isActive: ev.organizer.isActive,
          deletedAt: ev.organizer.deletedAt,
        }
      : undefined,

    // útil para deshabilitar acciones en el front
    organizerDeletedOrInactive,

    // portada/miniatura
    coverImageUrl: ev.coverImageUrl ?? null,
  };
}

/**
 * GET /api/admin/events
 * Query: page, pageSize, q, status (approved|pending), organizerId
 */
export async function adminListEvents(req: Request, res: Response) {
  const page = toInt(req.query.page, 1);
  const pageSize = Math.min(50, Math.max(5, toInt(req.query.pageSize, 10)));
  const q = toStr(req.query.q);
  const organizerId = toInt(req.query.organizerId, 0) || undefined;
  const statusQ = toStr(req.query.status) as AdminStatus;

  const where: any = {
    ...(q ? { title: { contains: q, mode: 'insensitive' } } : {}),
    ...(organizerId ? { organizerId } : {}),
    ...(statusQ && ALLOWED.has(statusQ)
      ? { approved: statusQ === 'approved' }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.event.findMany({
      where,
      orderBy: { updatedAt: 'desc' }, // puedes cambiar a { createdAt: 'desc' } si prefieres
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        organizer: {
          select: {
            id: true,
            name: true,
            email: true,
            isActive: true,
            deletedAt: true,
          },
        },
      },
    }),
    prisma.event.count({ where }),
  ]);

  res.json({
    items: items.map(mapEvent),
    total,
    page,
    pageSize,
  });
}

/**
 * GET /api/admin/events/:id
 * Obtiene los detalles de un evento específico
 */
export async function adminGetEvent(req: Request, res: Response) {
  const id = Number(req.params.id);
  
  // validar id
  if (!id || id <= 0) {
    return res.status(400).json({ error: 'ID de evento inválido' });
  }

  // objeto con la informacion del evento
  const ev = await prisma.event.findUnique({
    where: { id },
    include: {
      organizer: {
        select: {
          id: true,
          name: true,
          email: true,
          rut: true,
          isActive: true,
          deletedAt: true,
          // información de contacto del organizador
          application: {
            select: {
              phone: true,
              legalName: true,
            },
          },
        },
      },
    },
  });

  if (!ev) {
    return res.status(404).json({ error: 'Evento no encontrado' });
  }

  // estadisticas de ventas
  const [totalTicketsSold, totalRevenue] = await Promise.all([
    // total de entradas vendidas
    prisma.reservation.aggregate({
      where: {
        eventId: id,
        status: 'PAID',
      },
      _sum: {
        quantity: true,
      },
    }),
    // ingresos totales
    prisma.reservation.aggregate({
      where: {
        eventId: id,
        status: 'PAID',
      },
      _sum: {
        amount: true,
      },
    }),
  ]);

  const ticketsSold = totalTicketsSold._sum.quantity || 0;
  const availableTickets = Math.max(0, ev.capacity - ticketsSold);

  // Formatear información bancaria legacy del evento (si existe)
  const eventBankingInfo = ev.payoutBankName && ev.payoutAccountNumber ? {
    bankName: ev.payoutBankName,
    accountType: ev.payoutAccountType,
    accountNumber: ev.payoutAccountNumber,
    holderName: ev.payoutHolderName,
    holderRut: ev.payoutHolderRut,
  } : null;

  // Construir respuesta usando mapEvent + datos adicionales
  const mappedEvent = mapEvent(ev);

  res.json({
    ...mappedEvent,
    // Agregar campos adicionales del evento
    city: ev.city,
    commune: ev.commune,
    price: ev.price,
    
    // Estadísticas de ventas
    stats: {
      ticketsSold,
      availableTickets,
      totalRevenue: totalRevenue._sum.amount || 0,
    },
    
    // Información bancaria legacy del evento
    eventBankingInfo,
    
    // Información adicional del organizador
    organizer: ev.organizer ? {
      id: ev.organizer.id,
      name: ev.organizer.name,
      email: ev.organizer.email,
      rut: ev.organizer.rut,
      phone: ev.organizer.application?.phone || null,
      legalName: ev.organizer.application?.legalName || null,
      isActive: ev.organizer.isActive,
      deletedAt: ev.organizer.deletedAt,
    } : undefined,
  });
}

/**
 * PATCH /api/admin/events/:id/status
 * Body: { status: "approved" | "pending" }
 * -> setea event.approved en consecuencia
 *
 * 🔒 Si el organizador está ELIMINADO o INACTIVO, no permite aprobar.
 */
export async function adminSetEventStatus(req: Request, res: Response) {
  const id = Number(req.params.id);
  const status = toStr(req.body?.status) as AdminStatus;

  if (!ALLOWED.has(status)) {
    return res
      .status(400)
      .json({ error: 'Estado inválido (usa "approved" o "pending")' });
  }

  // Traemos el evento con estado del organizador para validar reglas
  const ev = await prisma.event.findUnique({
    where: { id },
    select: {
      id: true,
      approved: true,
      organizer: {
        select: {
          id: true,
          isActive: true,
          deletedAt: true,
        },
      },
    },
  });

  if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });

  // ❌ No permitir APROBAR si el organizador está eliminado o inactivo
  if (status === 'approved' && (!ev.organizer?.isActive || ev.organizer?.deletedAt)) {
    return res.status(409).json({
      error: 'No puedes aprobar eventos de cuentas eliminadas o inactivas.',
    });
  }

  const updated = await prisma.event.update({
    where: { id },
    data: { approved: status === 'approved' },
    include: {
      organizer: {
        select: {
          id: true,
          name: true,
          email: true,
          isActive: true,
          deletedAt: true,
        },
      },
    },
  });

  res.json(mapEvent(updated));
}

/**
 * DELETE /admin/events/:id - Eliminar un evento (solo superadmin)
 * Permite eliminar eventos antiguos del sistema LEGACY
 */
export async function adminDeleteEvent(req: Request, res: Response) {
  try {
    const id = toInt(req.params.id, 0);
    if (!id) return res.status(422).json({ error: 'ID inválido' });

    // Verificar que el evento existe
    const ev = await prisma.event.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            reservations: true,
            tickets: true,
          },
        },
      },
    });

    if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });

    // Verificar si tiene reservas o tickets asociados
    if (ev._count.reservations > 0 || ev._count.tickets > 0) {
      return res.status(409).json({
        error: 'No se puede eliminar el evento porque tiene reservas o tickets asociados',
        details: {
          reservations: ev._count.reservations,
          tickets: ev._count.tickets,
        },
      });
    }

    // Eliminar el evento
    await prisma.event.delete({
      where: { id },
    });

    res.json({ 
      success: true, 
      message: 'Evento eliminado correctamente',
    });
  } catch (err: any) {
    console.error('adminDeleteEvent error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
}

/**
 * PATCH /admin/events/:id/toggle-active
 * Activar o desactivar un evento como admin (incluso con ventas)
 */
export async function adminToggleEventActive(req: Request, res: Response) {
  try {
    const id = toInt(req.params.id, 0);
    if (!id) return res.status(422).json({ error: 'ID inválido' });

    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'El campo isActive debe ser boolean' });
    }

    // Verificar que el evento existe
    const event = await prisma.event.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            reservations: { where: { status: 'PAID' } },
          },
        },
      },
    });

    if (!event) return res.status(404).json({ error: 'Evento no encontrado' });

    // Actualizar estado del evento
    const updated = await prisma.event.update({
      where: { id },
      data: { isActive },
    });

    res.json({
      success: true,
      message: isActive ? 'Evento activado correctamente' : 'Evento desactivado correctamente',
      event: mapEvent(updated),
      paidReservations: event._count.reservations,
    });
  } catch (err: any) {
    console.error('adminToggleEventActive error:', err);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
}



