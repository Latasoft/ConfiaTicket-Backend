// src/controllers/admin.config.controller.ts
import { Request, Response } from 'express';
import prisma from '../prisma/client';
import { clearConfigCache } from '../services/config.service';

export async function listTicketLimits(_req: Request, res: Response) {
  const limits = await prisma.ticketLimitConfig.findMany();
  res.json({ items: limits });
}

export async function updateTicketLimit(req: Request, res: Response) {
  const eventType = req.params.eventType as string;
  const { minCapacity, maxCapacity } = req.body as {
    minCapacity: number;
    maxCapacity: number | null;
  };

  const errors: string[] = [];

  if (!eventType || !['OWN', 'RESALE'].includes(eventType)) {
    return res.status(400).json({ error: 'eventType debe ser OWN o RESALE' });
  }

  if (typeof minCapacity !== 'number' || minCapacity < 0) {
    errors.push('minCapacity debe ser un numero mayor o igual a 0');
  }

  // Para eventos OWN, maxCapacity puede ser null (sin límite)
  if (eventType === 'OWN') {
    if (maxCapacity !== null) {
      if (typeof maxCapacity !== 'number' || maxCapacity < 1) {
        errors.push('maxCapacity debe ser un numero mayor a 0 o null para sin límite');
      }
      if (typeof maxCapacity === 'number' && minCapacity >= maxCapacity) {
        errors.push('minCapacity debe ser menor que maxCapacity');
      }
    }
  } else {
    // RESALE siempre requiere maxCapacity
    if (typeof maxCapacity !== 'number' || maxCapacity < 1) {
      errors.push('maxCapacity debe ser un numero mayor a 0');
    }
    if (typeof maxCapacity === 'number' && minCapacity >= maxCapacity) {
      errors.push('minCapacity debe ser menor que maxCapacity');
    }
  }

  if (errors.length) {
    return res.status(400).json({ error: 'Datos invalidos', details: errors });
  }

  const updated = await prisma.ticketLimitConfig.upsert({
    where: { eventType },
    update: { minCapacity, maxCapacity },
    create: { eventType, minCapacity, maxCapacity },
  });

  clearConfigCache();
  res.json(updated);
}

export async function getPriceLimit(_req: Request, res: Response) {
  const limit = await prisma.priceLimitConfig.findFirst();
  res.json(limit);
}

export async function updatePriceLimit(req: Request, res: Response) {
  const { minPrice, maxPrice, resaleMarkupPercent } = req.body as {
    minPrice: number;
    maxPrice: number;
    resaleMarkupPercent: number;
  };

  const errors: string[] = [];

  if (typeof minPrice !== 'number' || minPrice < 0) {
    errors.push('minPrice debe ser un numero mayor o igual a 0');
  }
  if (typeof maxPrice !== 'number' || maxPrice < 1) {
    errors.push('maxPrice debe ser un numero mayor a 0');
  }
  if (minPrice >= maxPrice) {
    errors.push('minPrice debe ser menor que maxPrice');
  }
  if (typeof resaleMarkupPercent !== 'number' || resaleMarkupPercent < 0 || resaleMarkupPercent > 100) {
    errors.push('resaleMarkupPercent debe estar entre 0 y 100');
  }

  if (errors.length) {
    return res.status(400).json({ error: 'Datos invalidos', details: errors });
  }

  const existing = await prisma.priceLimitConfig.findFirst();

  let updated;
  if (existing) {
    updated = await prisma.priceLimitConfig.update({
      where: { id: existing.id },
      data: { minPrice, maxPrice, resaleMarkupPercent },
    });
  } else {
    updated = await prisma.priceLimitConfig.create({
      data: { minPrice, maxPrice, resaleMarkupPercent },
    });
  }

  clearConfigCache();
  res.json(updated);
}

export async function getPlatformFee(_req: Request, res: Response) {
  const fee = await prisma.platformFeeConfig.findFirst();
  res.json(fee);
}

export async function updatePlatformFee(req: Request, res: Response) {
  const { feeBps, description } = req.body as {
    feeBps: number;
    description?: string;
  };

  const errors: string[] = [];

  if (typeof feeBps !== 'number' || feeBps < 0) {
    errors.push('feeBps debe ser un numero mayor o igual a 0');
  }
  if (feeBps > 10000) {
    errors.push('feeBps no puede ser mayor a 10000 (100%)');
  }

  if (errors.length) {
    return res.status(400).json({ error: 'Datos invalidos', details: errors });
  }

  const existing = await prisma.platformFeeConfig.findFirst();

  let updated;
  if (existing) {
    updated = await prisma.platformFeeConfig.update({
      where: { id: existing.id },
      data: { 
        feeBps,
        ...(description !== undefined ? { description } : {}),
      },
    });
  } else {
    updated = await prisma.platformFeeConfig.create({
      data: { 
        feeBps,
        description: description || 'Comisión de la plataforma en basis points (100 bps = 1%)',
      },
    });
  }

  clearConfigCache();
  res.json(updated);
}

export async function listFieldLimits(req: Request, res: Response) {
  const { context } = req.query as { context?: string };

  const where = context ? { context } : {};
  const limits = await prisma.fieldLimitConfig.findMany({ where });
  
  res.json({ items: limits });
}

export async function updateFieldLimit(req: Request, res: Response) {
  const fieldName = req.params.fieldName as string;
  const { maxLength, context } = req.body as {
    maxLength: number;
    context?: string;
  };

  const errors: string[] = [];

  if (!fieldName) {
    return res.status(400).json({ error: 'fieldName es requerido' });
  }

  if (typeof maxLength !== 'number' || maxLength < 1) {
    errors.push('maxLength debe ser un numero mayor a 0');
  }

  if (errors.length) {
    return res.status(400).json({ error: 'Datos invalidos', details: errors });
  }

  const updated = await prisma.fieldLimitConfig.upsert({
    where: { fieldName },
    update: { maxLength, context: context || null },
    create: { fieldName, maxLength, context: context || null },
  });

  clearConfigCache();
  res.json(updated);
}

export async function listSystemConfigs(req: Request, res: Response) {
  const { category } = req.query as { category?: string };

  const where = category ? { category: category as any } : {};
  const configs = await prisma.systemConfig.findMany({ where });
  
  res.json({ items: configs });
}

export async function updateSystemConfig(req: Request, res: Response) {
  const key = req.params.key as string;
  const { value, category, dataType, description, isEditable } = req.body as {
    value: string;
    category?: string;
    dataType?: string;
    description?: string;
    isEditable?: boolean;
  };

  const errors: string[] = [];

  if (!key) {
    return res.status(400).json({ error: 'key es requerido' });
  }

  if (!value) {
    errors.push('value es requerido');
  }

  if (errors.length) {
    return res.status(400).json({ error: 'Datos invalidos', details: errors });
  }

  const updated = await prisma.systemConfig.upsert({
    where: { key },
    update: {
      value,
      ...(category ? { category: category as any } : {}),
      ...(dataType ? { dataType: dataType as any } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(isEditable !== undefined ? { isEditable } : {}),
    },
    create: {
      key,
      value,
      category: (category as any) || 'BUSINESS_RULE',
      dataType: (dataType as any) || 'STRING',
      description: description || null,
      isEditable: isEditable !== undefined ? isEditable : true,
    },
  });

  clearConfigCache();
  res.json(updated);
}

export async function getReservationHold(_req: Request, res: Response) {
  const hold = await prisma.reservationHoldConfig.findFirst();
  res.json(hold);
}

export async function updateReservationHold(req: Request, res: Response) {
  const { holdMinutes, description } = req.body as {
    holdMinutes: number;
    description?: string;
  };

  const errors: string[] = [];

  if (typeof holdMinutes !== 'number' || holdMinutes < 1) {
    errors.push('holdMinutes debe ser un numero mayor a 0');
  }
  if (holdMinutes > 60) {
    errors.push('holdMinutes no puede ser mayor a 60 (1 hora)');
  }

  if (errors.length) {
    return res.status(400).json({ error: 'Datos invalidos', details: errors });
  }

  const existing = await prisma.reservationHoldConfig.findFirst();

  let updated;
  if (existing) {
    updated = await prisma.reservationHoldConfig.update({
      where: { id: existing.id },
      data: { 
        holdMinutes,
        ...(description !== undefined ? { description } : {}),
      },
    });
  } else {
    updated = await prisma.reservationHoldConfig.create({
      data: { 
        holdMinutes,
        description: description || 'Tiempo en minutos que una reserva se mantiene bloqueada antes de expirar',
      },
    });
  }

  clearConfigCache();
  res.json(updated);
}
