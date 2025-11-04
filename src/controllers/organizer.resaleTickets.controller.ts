// src/controllers/organizer.resaleTickets.controller.ts
// Este controlador solo maneja tickets de reventa (resale)
// Para eventos propios (own), usar organizer.ownEventSections.controller.ts
import { Request, Response } from 'express';
import prisma from '../prisma/client';
import { getFieldLimits } from '../services/config.service';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { extractQrFromImage } from '../services/qrExtractor.service';

type Authed = { id: number; role: string };

function toStr(v: unknown) {
  return String(v ?? '').trim();
}

function toInt(val: unknown, def?: number): number | undefined {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.floor(n);
}

/**
 * POST /api/organizer/events/:eventId/tickets
 * Crear ticket RESALE con imagen
 * Requiere multipart/form-data con archivo de imagen
 */
export async function createTicket(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const eventId = Number(req.params.eventId);

  const event = await prisma.event.findFirst({
    where: { id: eventId, organizerId: user.id, eventType: 'RESALE' },
    select: { id: true, capacity: true },
  });

  if (!event) {
    return res.status(404).json({ error: 'Evento no encontrado o no es de tipo RESALE' });
  }

  // Obtener el límite máximo configurado por el admin
  const ticketLimit = await prisma.ticketLimitConfig.findUnique({
    where: { eventType: 'RESALE' },
  });

  const maxTickets = ticketLimit?.maxCapacity ?? 4; // Fallback a 4

  const existingCount = await prisma.ticket.count({ where: { eventId } });

  if (existingCount >= maxTickets) {
    return res.status(400).json({ 
      error: `Máximo ${maxTickets} tickets permitidos para eventos de reventa` 
    });
  }

  // Archivo cargado por middleware multer (upload.single)
  const ticketImageFile = (req as any).file as Express.Multer.File | undefined;

  if (!ticketImageFile) {
    return res.status(400).json({ error: 'Se requiere imagen del ticket (campo "file")' });
  }

  const {
    ticketCode,
    row,
    seat,
    zone,
    level,
  } = req.body as {
    ticketCode: string;
    row: string;
    seat: string;
    zone?: string;
    level?: string;
  };

  const FIELD_LIMITS = await getFieldLimits();
  const errors: string[] = [];

  const _ticketCode = toStr(ticketCode);
  const _row = toStr(row);
  const _seat = toStr(seat);

  if (!_ticketCode) errors.push('ticketCode es requerido');
  if (!_row) errors.push('row es requerido');
  if (!_seat) errors.push('seat es requerido');

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

  // Normalizar zone: convertir cadenas vacías a null para consistencia
  const normalizedZone = _zone || null;

  // Validar duplicados por (eventId, row, seat, zone)
  // Esto permite el mismo asiento en diferentes zonas/secciones
  if (_row && _seat) {
    const duplicate = await prisma.ticket.findFirst({
      where: { 
        eventId, 
        row: _row,
        seat: _seat,
        zone: normalizedZone,
      },
    });
    if (duplicate) {
      const zoneMsg = normalizedZone ? ` en la zona "${normalizedZone}"` : '';
      errors.push(`Ya existe un ticket para fila "${_row}", asiento "${_seat}"${zoneMsg} en este evento`);
    }
  }

  if (errors.length) {
    // Eliminar archivo subido si hay errores
    await fs.unlink(ticketImageFile.path).catch(() => {});
    return res.status(400).json({ error: 'Datos inválidos', details: errors });
  }

  // Calcular checksum de la imagen del ticket
  const fileBuffer = await fs.readFile(ticketImageFile.path);
  const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  // Extraer QR de la imagen original (OBLIGATORIO)
  console.log('Extrayendo QR del ticket original...');
  let originalQrCode: string | null = null;
  try {
    originalQrCode = await extractQrFromImage(ticketImageFile.path);
    
    if (!originalQrCode) {
      // Si no se pudo extraer QR, eliminar el archivo y rechazar
      await fs.unlink(ticketImageFile.path).catch(() => {});
      return res.status(400).json({ 
        error: 'No se pudo extraer el código QR de la imagen del ticket',
        details: [
          'La imagen debe contener un código QR válido y legible.',
          'Asegúrate de que la imagen sea clara y el QR esté completamente visible.',
          'Formatos aceptados: JPG, PNG con buena resolución.'
        ]
      });
    }
    
    console.log('✅ QR extraído exitosamente');
  } catch (qrError) {
    console.error('❌ Error al extraer QR:', qrError);
    // Eliminar el archivo subido si falla la extracción
    await fs.unlink(ticketImageFile.path).catch(() => {});
    return res.status(400).json({ 
      error: 'Error al procesar la imagen del ticket',
      details: [
        'No se pudo leer el código QR de la imagen.',
        'Verifica que la imagen no esté corrupta y contenga un QR válido.',
        'Intenta con una imagen de mejor calidad o tomada desde otro ángulo.'
      ]
    });
  }

  // Generar QR proxy único (UUID)
  const proxyQrCode = crypto.randomUUID();
  console.log('QR Proxy generado:', proxyQrCode);

  try {
    const ticket = await prisma.ticket.create({
      data: {
        eventId,
        ticketCode: _ticketCode,
        row: _row,
        seat: _seat,
        zone: normalizedZone,
        level: _level || null,
        imageFilePath: ticketImageFile.path,
        imageFileName: ticketImageFile.originalname,
        imageMime: ticketImageFile.mimetype,
        imageChecksum: checksum,
        originalQrCode: originalQrCode || null,
        proxyQrCode,
        scannedCount: 0,
      },
    });

    return res.status(201).json(ticket);
  } catch (error: any) {
    // Eliminar el archivo subido si falla la creación
    await fs.unlink(ticketImageFile.path).catch(() => {});
    
    // Manejar error de constraint único
    if (error?.code === 'P2002') {
      const zoneMsg = normalizedZone ? ` en la zona "${normalizedZone}"` : '';
      return res.status(400).json({ 
        error: `Ya existe un ticket para fila "${_row}", asiento "${_seat}"${zoneMsg} en este evento`,
        details: ['Por favor verifica que no hayas ingresado este ticket anteriormente']
      });
    }
    
    // Para otros errores, log en servidor pero mensaje genérico al cliente
    console.error('Error creando ticket:', error);
    return res.status(500).json({ 
      error: 'Error al crear el ticket',
      details: ['Ocurrió un error inesperado. Por favor intenta nuevamente.']
    });
  }
}


/**
 * GET /api/organizer/events/:eventId/tickets
 * Listar tickets RESALE del evento
 */
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
    include: {
      reservation: {
        include: {
          buyer: { select: { id: true, email: true, name: true } },
        },
      },
    },
  });

  res.json(tickets);
}

/**
 * GET /api/organizer/events/:eventId/tickets/:ticketId
 * Obtener ticket específico con detalles
 */
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
    include: {
      event: true,
      reservation: {
        include: {
          buyer: { select: { id: true, email: true, name: true } },
        },
      },
    },
  });

  if (!ticket) {
    return res.status(404).json({ error: 'Ticket no encontrado' });
  }

  res.json(ticket);
}

/**
 * PUT /api/organizer/events/:eventId/tickets/:ticketId
 * Actualizar ticket RESALE (solo si no está vendido)
 */
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
  });

  if (!ticket) {
    return res.status(404).json({ error: 'Ticket no encontrado' });
  }

  if (ticket.sold) {
    return res.status(400).json({ error: 'No se puede modificar un ticket ya vendido' });
  }

  const FIELD_LIMITS = await getFieldLimits();

  const {
    ticketCode,
    row,
    seat,
    zone,
    level,
  } = req.body as Partial<{
    ticketCode: string;
    row: string;
    seat: string;
    zone: string;
    level: string;
  }>;

  const errors: string[] = [];
  const data: any = {};

  if (ticketCode !== undefined) {
    const v = toStr(ticketCode);
    if (!v) errors.push('ticketCode no puede estar vacío');
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
    if (v) data.ticketCode = v;
  }

  if (row !== undefined) {
    const v = toStr(row);
    if (!v) errors.push('row no puede estar vacío');
    if (v && v.length > FIELD_LIMITS.TICKET_ROW) {
      errors.push(`row excede ${FIELD_LIMITS.TICKET_ROW} caracteres`);
    }
    if (v) data.row = v;
  }

  if (seat !== undefined) {
    const v = toStr(seat);
    if (!v) errors.push('seat no puede estar vacío');
    if (v && v.length > FIELD_LIMITS.TICKET_SEAT) {
      errors.push(`seat excede ${FIELD_LIMITS.TICKET_SEAT} caracteres`);
    }
    if (v) data.seat = v;
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

  if (errors.length) {
    return res.status(400).json({ error: 'Datos inválidos', details: errors });
  }

  const updated = await prisma.ticket.update({
    where: { id: ticketId },
    data,
  });

  res.json(updated);
}

/**
 * DELETE /api/organizer/events/:eventId/tickets/:ticketId
 * Eliminar ticket (solo si NO está vendido)
 */
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

  if (ticket.sold) {
    return res.status(400).json({ error: 'No se puede eliminar un ticket ya vendido' });
  }

  // Eliminar archivo de imagen
  if (ticket.imageFilePath) {
    await fs.unlink(ticket.imageFilePath).catch(() => {
      // No fallar si el archivo ya no existe
    });
  }

  await prisma.ticket.delete({ where: { id: ticketId } });

  res.status(204).send();
}

