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
 */
export async function adminGetEvent(req: Request, res: Response) {
  const id = Number(req.params.id);
  const ev = await prisma.event.findUnique({
    where: { id },
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
  if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });
  res.json(mapEvent(ev));
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



