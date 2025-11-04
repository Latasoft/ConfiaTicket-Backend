// src/controllers/organizer.ownEventSections.controller.ts
// Este controlador solo maneja secciones de eventos propios (own)
// Para eventos de reventa (resale), usar organizer.resaleTickets.controller.ts
//
// REGLAS DE CAPACIDAD:
// 1. Capacidad de sección = suma de capacidades de sus filas
//    Ejemplo: Fila A (10 asientos) + Fila B (10 asientos) = Sección (20)
// 2. Suma de capacidades de secciones ≤ capacidad del evento
//    Ejemplo: Sección VIP (20) + Sección General (20) ≤ Evento (40)
// 3. Reservas por sección ≤ capacidad de la sección
//    (Validado en bookings.controller.ts)
//
import { Request, Response } from 'express';
import prisma from '../prisma/client';
import { getFieldLimits } from '../services/config.service';

type Authed = { id: number; role: string };

/**
 * Calcula el número de filas entre rowStart y rowEnd
 * Soporta tanto números (1, 2, 3) como letras (A, B, C)
 */
function calculateRowCount(rowStart: string, rowEnd: string): number | null {
  const start = rowStart.trim().toUpperCase();
  const end = rowEnd.trim().toUpperCase();
  
  // Intentar como números
  const startNum = parseInt(start);
  const endNum = parseInt(end);
  
  if (!isNaN(startNum) && !isNaN(endNum)) {
    if (endNum >= startNum) {
      return endNum - startNum + 1;
    }
    return null; // Rango inválido
  }
  
  // Intentar como letras (A-Z, AA-ZZ, etc.)
  if (/^[A-Z]+$/.test(start) && /^[A-Z]+$/.test(end)) {
    // Convertir letras a número (A=1, B=2, ..., Z=26, AA=27, etc.)
    const letterToNumber = (str: string): number => {
      let result = 0;
      for (let i = 0; i < str.length; i++) {
        result = result * 26 + (str.charCodeAt(i) - 64);
      }
      return result;
    };
    
    const startValue = letterToNumber(start);
    const endValue = letterToNumber(end);
    
    if (endValue >= startValue) {
      return endValue - startValue + 1;
    }
    return null; // Rango inválido
  }
  
  // Si no se puede calcular, retornar null
  return null;
}

// Helper functions
function toStr(v: unknown) {
  return String(v ?? '').trim();
}

function toInt(val: unknown, def?: number): number | undefined {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.floor(n);
}

/**
 * Valida que la suma de capacidades de secciones no exceda la capacidad del evento
 * @param eventId ID del evento
 * @param newSectionCapacity Capacidad de la nueva sección o sección actualizada
 * @param excludeSectionId ID de sección a excluir (para actualizaciones)
 * @returns { valid: boolean, error?: object }
 */
async function validateEventCapacity(
  eventId: number,
  newSectionCapacity: number,
  excludeSectionId?: number
): Promise<{ valid: boolean; error?: any }> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { capacity: true },
  });

  if (!event) {
    return {
      valid: false,
      error: { error: 'Evento no encontrado' },
    };
  }

  // Obtener la suma de capacidades de otras secciones
  const otherSections = await prisma.eventSection.findMany({
    where: {
      eventId,
      ...(excludeSectionId ? { id: { not: excludeSectionId } } : {}),
    },
    select: { totalCapacity: true },
  });

  const otherSectionsCapacity = otherSections.reduce((sum, s) => sum + s.totalCapacity, 0);
  const totalCapacity = otherSectionsCapacity + newSectionCapacity;

  if (totalCapacity > event.capacity) {
    return {
      valid: false,
      error: {
        error: 'La suma de las capacidades de todas las secciones excede la capacidad del evento',
        details: {
          eventCapacity: event.capacity,
          existingSectionsCapacity: otherSectionsCapacity,
          newSectionCapacity,
          totalAfterChange: totalCapacity,
          exceededBy: totalCapacity - event.capacity,
          available: Math.max(0, event.capacity - otherSectionsCapacity),
        },
      },
    };
  }

  return { valid: true };
}

/**
 * POST /api/organizer/events/:eventId/sections
 * Crear sección para evento OWN
 */
export async function createSection(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const eventId = Number(req.params.eventId);

  const event = await prisma.event.findFirst({
    where: { id: eventId, organizerId: user.id, eventType: 'OWN' },
    select: { id: true, capacity: true },
  });

  if (!event) {
    return res.status(404).json({ error: 'Evento no encontrado o no es de tipo OWN' });
  }

  const {
    name,
    rowStart,
    rowEnd,
    seatsPerRow,
    seatStart,
    seatEnd,
    description,
  } = req.body as {
    name: string;
    rowStart?: string;
    rowEnd?: string;
    seatsPerRow?: number;
    seatStart?: number;
    seatEnd?: number;
    description?: string;
  };

  const FIELD_LIMITS = await getFieldLimits();
  const errors: string[] = [];

  const _name = toStr(name);
  if (!_name) errors.push('name es requerido');
  if (_name && _name.length > FIELD_LIMITS.TICKET_SECTION) {
    errors.push(`name excede ${FIELD_LIMITS.TICKET_SECTION} caracteres`);
  }

  // Calcular capacidad total de la sección
  // Regla: Capacidad = número de filas × asientos por fila
  // O bien: Capacidad = rango de asientos (seatEnd - seatStart + 1)
  let totalCapacity = 0;
  const _seatsPerRow = toInt(seatsPerRow);
  const _seatStart = toInt(seatStart);
  const _seatEnd = toInt(seatEnd);

  if (_seatsPerRow && _seatsPerRow > 0) {
    // Modo: filas con asientos por fila
    // Ejemplo: Fila A a Fila B, 10 asientos por fila = 2 × 10 = 20
    const _rowStart = toStr(rowStart);
    const _rowEnd = toStr(rowEnd);
    
    if (_rowStart && _rowEnd) {
      const numRows = calculateRowCount(_rowStart, _rowEnd);
      
      if (numRows !== null && numRows > 0) {
        totalCapacity = numRows * _seatsPerRow;
      } else {
        errors.push('Rango de filas inválido: la fila final debe ser mayor o igual a la fila inicial');
      }
    } else {
      errors.push('Se requiere rowStart y rowEnd cuando se especifica seatsPerRow');
    }
  } else if (_seatStart && _seatEnd && _seatEnd >= _seatStart) {
    totalCapacity = _seatEnd - _seatStart + 1;
  }

  if (totalCapacity <= 0) {
    errors.push('No se pudo calcular la capacidad total de la sección');
  }

  if (errors.length) {
    return res.status(400).json({ error: 'Datos invalidos', details: errors });
  }

  // Validar que la suma de capacidades de todas las secciones no exceda la capacidad del evento
  const validation = await validateEventCapacity(eventId, totalCapacity);
  if (!validation.valid) {
    return res.status(400).json(validation.error);
  }

  const section = await prisma.eventSection.create({
    data: {
      eventId,
      name: _name,
      rowStart: toStr(rowStart) || null,
      rowEnd: toStr(rowEnd) || null,
      seatsPerRow: _seatsPerRow || null,
      seatStart: _seatStart || null,
      seatEnd: _seatEnd || null,
      totalCapacity,
      description: toStr(description) || null,
    },
  });

  return res.status(201).json(section);
}

/**
 * GET /api/organizer/events/:eventId/sections
 * Listar secciones del evento
 */
export async function listSections(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const eventId = Number(req.params.eventId);

  const event = await prisma.event.findFirst({
    where: { id: eventId, organizerId: user.id },
  });

  if (!event) {
    return res.status(404).json({ error: 'Evento no encontrado' });
  }

  const sections = await prisma.eventSection.findMany({
    where: { eventId },
    orderBy: { createdAt: 'asc' },
  });

  res.json(sections);
}

/**
 * GET /api/organizer/events/:eventId/sections/:sectionId
 * Obtener sección específica
 */
export async function getSection(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const eventId = Number(req.params.eventId);
  const sectionId = Number(req.params.sectionId);

  const section = await prisma.eventSection.findFirst({
    where: {
      id: sectionId,
      eventId,
      event: { organizerId: user.id },
    },
    include: { event: true },
  });

  if (!section) {
    return res.status(404).json({ error: 'Sección no encontrada' });
  }

  res.json(section);
}

/**
 * PUT /api/organizer/events/:eventId/sections/:sectionId
 * Actualizar sección
 */
export async function updateSection(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const eventId = Number(req.params.eventId);
  const sectionId = Number(req.params.sectionId);

  const section = await prisma.eventSection.findFirst({
    where: {
      id: sectionId,
      eventId,
      event: { organizerId: user.id },
    },
  });

  if (!section) {
    return res.status(404).json({ error: 'Sección no encontrada' });
  }

  const FIELD_LIMITS = await getFieldLimits();
  const {
    name,
    rowStart,
    rowEnd,
    seatsPerRow,
    seatStart,
    seatEnd,
    description,
  } = req.body as Partial<{
    name: string;
    rowStart: string;
    rowEnd: string;
    seatsPerRow: number;
    seatStart: number;
    seatEnd: number;
    description: string;
  }>;

  const errors: string[] = [];
  const data: any = {};

  if (name !== undefined) {
    const v = toStr(name);
    if (v && v.length > FIELD_LIMITS.TICKET_SECTION) {
      errors.push(`name excede ${FIELD_LIMITS.TICKET_SECTION} caracteres`);
    }
    data.name = v || null;
  }

  if (rowStart !== undefined) data.rowStart = toStr(rowStart) || null;
  if (rowEnd !== undefined) data.rowEnd = toStr(rowEnd) || null;
  if (seatsPerRow !== undefined) data.seatsPerRow = toInt(seatsPerRow) || null;
  if (seatStart !== undefined) data.seatStart = toInt(seatStart) || null;
  if (seatEnd !== undefined) data.seatEnd = toInt(seatEnd) || null;
  
  if (description !== undefined) {
    const v = toStr(description);
    if (v && v.length > FIELD_LIMITS.TICKET_DESCRIPTION) {
      errors.push(`description excede ${FIELD_LIMITS.TICKET_DESCRIPTION} caracteres`);
    }
    data.description = v || null;
  }

  // Recalcular capacidad si cambió algo relevante
  // Regla: Capacidad de sección = suma de capacidades de sus filas
  if (
    seatsPerRow !== undefined ||
    rowStart !== undefined ||
    rowEnd !== undefined ||
    seatStart !== undefined ||
    seatEnd !== undefined
  ) {
    const _seatsPerRow = data.seatsPerRow ?? section.seatsPerRow;
    const _seatStart = data.seatStart ?? section.seatStart;
    const _seatEnd = data.seatEnd ?? section.seatEnd;

    let totalCapacity = 0;
    if (_seatsPerRow && _seatsPerRow > 0) {
      const _rowStart = data.rowStart ?? section.rowStart;
      const _rowEnd = data.rowEnd ?? section.rowEnd;

      if (_rowStart && _rowEnd) {
        const numRows = calculateRowCount(_rowStart, _rowEnd);
        
        if (numRows !== null && numRows > 0) {
          totalCapacity = numRows * _seatsPerRow;
        } else {
          errors.push('Rango de filas inválido: la fila final debe ser mayor o igual a la fila inicial');
        }
      } else {
        errors.push('Se requiere rowStart y rowEnd cuando se especifica seatsPerRow');
      }
    } else if (_seatStart && _seatEnd && _seatEnd >= _seatStart) {
      totalCapacity = _seatEnd - _seatStart + 1;
    }

    if (totalCapacity > 0) {
      data.totalCapacity = totalCapacity;
      
      // Validar que la suma de capacidades no exceda la capacidad del evento
      const validation = await validateEventCapacity(eventId, totalCapacity, sectionId);
      if (!validation.valid) {
        return res.status(400).json(validation.error);
      }
    }
  }

  if (errors.length) {
    return res.status(400).json({ error: 'Datos invalidos', details: errors });
  }

  const updated = await prisma.eventSection.update({
    where: { id: sectionId },
    data,
  });

  res.json(updated);
}

/**
 * DELETE /api/organizer/events/:eventId/sections/:sectionId
 * Eliminar sección
 */
export async function deleteSection(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const eventId = Number(req.params.eventId);
  const sectionId = Number(req.params.sectionId);

  const section = await prisma.eventSection.findFirst({
    where: {
      id: sectionId,
      eventId,
      event: { organizerId: user.id },
    },
  });

  if (!section) {
    return res.status(404).json({ error: 'Sección no encontrada' });
  }

  await prisma.eventSection.delete({ where: { id: sectionId } });

  res.status(204).send();
}

/**
 * Helper: Verifica si un evento OWN tiene todas sus secciones completas
 * @param eventId ID del evento
 * @returns { complete: boolean, eventCapacity: number, sectionsCapacity: number, missingCapacity: number }
 */
export async function checkEventSectionsComplete(eventId: number) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { capacity: true, eventType: true },
  });

  if (!event) {
    return null;
  }

  // Para eventos RESALE, verificar tickets en lugar de secciones
  if (event.eventType === 'RESALE') {
    const ticketsCount = await prisma.ticket.count({
      where: { eventId },
    });
    
    return {
      complete: ticketsCount === event.capacity,
      eventCapacity: event.capacity,
      sectionsCapacity: ticketsCount,
      missingCapacity: Math.max(0, event.capacity - ticketsCount),
    };
  }

  // Para eventos OWN, verificar secciones
  const sections = await prisma.eventSection.findMany({
    where: { eventId },
    select: { totalCapacity: true },
  });

  const sectionsCapacity = sections.reduce((sum, s) => sum + s.totalCapacity, 0);
  const missingCapacity = Math.max(0, event.capacity - sectionsCapacity);

  return {
    complete: sectionsCapacity === event.capacity,
    eventCapacity: event.capacity,
    sectionsCapacity,
    missingCapacity,
  };
}

/**
 * GET /api/organizer/events/:eventId/sections/status
 * Verificar si el evento tiene todas sus secciones completas
 */
export async function getSectionsStatus(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const eventId = Number(req.params.eventId);

  const event = await prisma.event.findFirst({
    where: { id: eventId, organizerId: user.id },
  });

  if (!event) {
    return res.status(404).json({ error: 'Evento no encontrado' });
  }

  const status = await checkEventSectionsComplete(eventId);

  if (!status) {
    return res.status(404).json({ error: 'Evento no encontrado' });
  }

  res.json(status);
}
