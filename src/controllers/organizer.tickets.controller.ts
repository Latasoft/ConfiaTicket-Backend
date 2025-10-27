// src/controllers/organizer.tickets.controller.ts
import { Request, Response } from 'express';
import prisma from '../prisma/client';
import { getFieldLimits } from '../services/config.service';

type Authed = { id: number; role: string };

function toStr(v: unknown) {
  return String(v ?? '').trim();
}

function toInt(val: unknown, def?: number): number | undefined {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.floor(n);
}

export async function createTicket(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const eventId = Number(req.params.eventId);

  const event = await prisma.event.findFirst({
    where: { id: eventId, organizerId: user.id },
    select: { id: true, eventType: true, capacity: true },
  });

  if (!event) {
    return res.status(404).json({ error: 'Evento no encontrado' });
  }

  const existingCount = await prisma.ticket.count({ where: { eventId } });

  const {
    ticketCode,
    row,
    seat,
    zone,
    level,
    sectionName,
    rowStart,
    rowEnd,
    seatsPerRow,
    seatStart,
    seatEnd,
    description,
  } = req.body as {
    ticketCode?: string;
    row?: string;
    seat?: string;
    zone?: string;
    level?: string;
    sectionName?: string;
    rowStart?: string;
    rowEnd?: string;
    seatsPerRow?: number;
    seatStart?: number;
    seatEnd?: number;
    description?: string;
  };

  const FIELD_LIMITS = await getFieldLimits();
  const errors: string[] = [];

  if (existingCount >= event.capacity) {
    return res.status(400).json({ error: 'Se ha alcanzado la capacidad máxima del evento' });
  }

  if (event.eventType === 'RESALE') {
    const _ticketCode = toStr(ticketCode);
    const _row = toStr(row);
    const _seat = toStr(seat);

    if (!_ticketCode) errors.push('ticketCode es requerido para eventos de reventa');
    if (!_row) errors.push('row es requerido para eventos de reventa');
    if (!_seat) errors.push('seat es requerido para eventos de reventa');

    if (_ticketCode && _ticketCode.length > FIELD_LIMITS.TICKET_CODE) {
      errors.push(`ticketCode excede ${FIELD_LIMITS.TICKET_CODE} caracteres`);
    }
    if (_row && _row.length > FIELD_LIMITS.TICKET_ROW) {
      errors.push(`row excede ${FIELD_LIMITS.TICKET_ROW} caracteres`);
    }
    if (_seat && _seat.length > FIELD_LIMITS.TICKET_SEAT) {
      errors.push(`seat excede ${FIELD_LIMITS.TICKET_SEAT} caracteres`);
    }

    const _zone = toStr(zone);
    if (_zone && _zone.length > FIELD_LIMITS.TICKET_ZONE) {
      errors.push(`zone excede ${FIELD_LIMITS.TICKET_ZONE} caracteres`);
    }

    const _level = toStr(level);
    if (_level && _level.length > FIELD_LIMITS.TICKET_LEVEL) {
      errors.push(`level excede ${FIELD_LIMITS.TICKET_LEVEL} caracteres`);
    }

    if (_ticketCode) {
      const duplicate = await prisma.ticket.findFirst({
        where: { eventId, ticketCode: _ticketCode },
      });
      if (duplicate) {
        errors.push('Ya existe un ticket con ese codigo en este evento');
      }
    }

    if (errors.length) {
      return res.status(400).json({ error: 'Datos inválidos', details: errors });
    }

    const ticket = await prisma.ticket.create({
      data: {
        eventId,
        ticketCode: _ticketCode,
        row: _row,
        seat: _seat,
        zone: _zone || null,
        level: _level || null,
        description: toStr(description) || null,
      },
    });

    return res.status(201).json(ticket);
  } else {
    const _sectionName = toStr(sectionName);
    const _rowStart = toStr(rowStart);
    const _rowEnd = toStr(rowEnd);
    const _seatsPerRow = toInt(seatsPerRow);
    const _seatStart = toInt(seatStart);
    const _seatEnd = toInt(seatEnd);

    if (!_sectionName) errors.push('sectionName es requerido para eventos propios');

    if (_sectionName && _sectionName.length > FIELD_LIMITS.TICKET_SECTION) {
      errors.push(`sectionName excede ${FIELD_LIMITS.TICKET_SECTION} caracteres`);
    }
    if (_rowStart && _rowStart.length > FIELD_LIMITS.TICKET_ROW) {
      errors.push(`rowStart excede ${FIELD_LIMITS.TICKET_ROW} caracteres`);
    }
    if (_rowEnd && _rowEnd.length > FIELD_LIMITS.TICKET_ROW) {
      errors.push(`rowEnd excede ${FIELD_LIMITS.TICKET_ROW} caracteres`);
    }

    if (errors.length) {
      return res.status(400).json({ error: 'Datos inválidos', details: errors });
    }

    const ticket = await prisma.ticket.create({
      data: {
        eventId,
        sectionName: _sectionName,
        rowStart: _rowStart || null,
        rowEnd: _rowEnd || null,
        seatsPerRow: _seatsPerRow || null,
        seatStart: _seatStart || null,
        seatEnd: _seatEnd || null,
        description: toStr(description) || null,
      },
    });

    return res.status(201).json(ticket);
  }
}

export async function listTickets(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const eventId = Number(req.params.eventId);

  const event = await prisma.event.findFirst({
    where: { id: eventId, organizerId: user.id },
  });

  if (!event) {
    return res.status(404).json({ error: 'Evento no encontrado' });
  }

  const tickets = await prisma.ticket.findMany({
    where: { eventId },
    orderBy: { createdAt: 'asc' },
  });

  res.json({ items: tickets, total: tickets.length });
}

export async function getTicket(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const eventId = Number(req.params.eventId);
  const ticketId = Number(req.params.ticketId);

  const ticket = await prisma.ticket.findFirst({
    where: {
      id: ticketId,
      eventId,
      event: { organizerId: user.id },
    },
    include: { event: true },
  });

  if (!ticket) {
    return res.status(404).json({ error: 'Ticket no encontrado' });
  }

  res.json(ticket);
}

export async function updateTicket(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const eventId = Number(req.params.eventId);
  const ticketId = Number(req.params.ticketId);

  const ticket = await prisma.ticket.findFirst({
    where: {
      id: ticketId,
      eventId,
      event: { organizerId: user.id },
    },
    include: { event: true },
  });

  if (!ticket) {
    return res.status(404).json({ error: 'Ticket no encontrado' });
  }

  const FIELD_LIMITS = await getFieldLimits();

  const {
    ticketCode,
    row,
    seat,
    zone,
    level,
    sectionName,
    rowStart,
    rowEnd,
    seatsPerRow,
    seatStart,
    seatEnd,
    description,
  } = req.body as Partial<{
    ticketCode: string;
    row: string;
    seat: string;
    zone: string;
    level: string;
    sectionName: string;
    rowStart: string;
    rowEnd: string;
    seatsPerRow: number;
    seatStart: number;
    seatEnd: number;
    description: string;
  }>;

  const errors: string[] = [];
  const data: any = {};

  if (ticket.event.eventType === 'RESALE') {
    if (ticketCode !== undefined) {
      const v = toStr(ticketCode);
      if (v && v.length > FIELD_LIMITS.TICKET_CODE) {
        errors.push(`ticketCode excede ${FIELD_LIMITS.TICKET_CODE} caracteres`);
      }
      if (v && v !== ticket.ticketCode) {
        const duplicate = await prisma.ticket.findFirst({
          where: { eventId, ticketCode: v, id: { not: ticketId } },
        });
        if (duplicate) {
          errors.push('Ya existe un ticket con ese codigo en este evento');
        }
      }
      data.ticketCode = v || null;
    }
    if (row !== undefined) {
      const v = toStr(row);
      if (v && v.length > FIELD_LIMITS.TICKET_ROW) {
        errors.push(`row excede ${FIELD_LIMITS.TICKET_ROW} caracteres`);
      }
      data.row = v || null;
    }
    if (seat !== undefined) {
      const v = toStr(seat);
      if (v && v.length > FIELD_LIMITS.TICKET_SEAT) {
        errors.push(`seat excede ${FIELD_LIMITS.TICKET_SEAT} caracteres`);
      }
      data.seat = v || null;
    }
    if (zone !== undefined) {
      const v = toStr(zone);
      if (v && v.length > FIELD_LIMITS.TICKET_ZONE) {
        errors.push(`zone excede ${FIELD_LIMITS.TICKET_ZONE} caracteres`);
      }
      data.zone = v || null;
    }
    if (level !== undefined) {
      const v = toStr(level);
      if (v && v.length > FIELD_LIMITS.TICKET_LEVEL) {
        errors.push(`level excede ${FIELD_LIMITS.TICKET_LEVEL} caracteres`);
      }
      data.level = v || null;
    }
  } else {
    if (sectionName !== undefined) {
      const v = toStr(sectionName);
      if (v && v.length > FIELD_LIMITS.TICKET_SECTION) {
        errors.push(`sectionName excede ${FIELD_LIMITS.TICKET_SECTION} caracteres`);
      }
      data.sectionName = v || null;
    }
    if (rowStart !== undefined) {
      const v = toStr(rowStart);
      if (v && v.length > FIELD_LIMITS.TICKET_ROW) {
        errors.push(`rowStart excede ${FIELD_LIMITS.TICKET_ROW} caracteres`);
      }
      data.rowStart = v || null;
    }
    if (rowEnd !== undefined) {
      const v = toStr(rowEnd);
      if (v && v.length > FIELD_LIMITS.TICKET_ROW) {
        errors.push(`rowEnd excede ${FIELD_LIMITS.TICKET_ROW} caracteres`);
      }
      data.rowEnd = v || null;
    }
    if (seatsPerRow !== undefined) {
      const v = toInt(seatsPerRow);
      data.seatsPerRow = v || null;
    }
    if (seatStart !== undefined) {
      const v = toInt(seatStart);
      data.seatStart = v || null;
    }
    if (seatEnd !== undefined) {
      const v = toInt(seatEnd);
      data.seatEnd = v || null;
    }
  }

  if (description !== undefined) {
    const v = toStr(description);
    if (v && v.length > FIELD_LIMITS.TICKET_DESCRIPTION) {
      errors.push(`description excede ${FIELD_LIMITS.TICKET_DESCRIPTION} caracteres`);
    }
    data.description = v || null;
  }

  if (errors.length) {
    return res.status(400).json({ error: 'Datos inválidos', details: errors });
  }

  const updated = await prisma.ticket.update({
    where: { id: ticketId },
    data,
  });

  res.json(updated);
}

export async function deleteTicket(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const eventId = Number(req.params.eventId);
  const ticketId = Number(req.params.ticketId);

  const ticket = await prisma.ticket.findFirst({
    where: {
      id: ticketId,
      eventId,
      event: { organizerId: user.id },
    },
  });

  if (!ticket) {
    return res.status(404).json({ error: 'Ticket no encontrado' });
  }

  await prisma.ticket.delete({ where: { id: ticketId } });

  res.status(204).send();
}
