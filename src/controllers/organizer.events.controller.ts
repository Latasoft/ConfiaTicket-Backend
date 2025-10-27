// src/controllers/organizer.events.controller.ts
import { Request, Response } from 'express';
import prisma from '../prisma/client';
import { calculateMaxResalePrice } from '../services/config.service';
import { loadAllLimits } from '../utils/config-loader';

type Authed = { id: number; role: string };

function toInt(val: unknown, def: number) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}
function toStr(v: unknown) {
  return String(v ?? '').trim();
}

function normalizeRut(input: string): string {
  const raw = String(input || '')
    .replace(/\./g, '')
    .replace(/-/g, '')
    .toUpperCase();
  const m = raw.match(/^(\d{7,8})([0-9K])$/);
  if (!m) return '';
  const body = m[1]!;
  const dv = m[2]!;
  return `${body}-${dv}`;
}
function calcRutDv(body: string): string {
  let sum = 0;
  let mul = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += parseInt(body[i]!, 10) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const res = 11 - (sum % 11);
  if (res === 11) return '0';
  if (res === 10) return 'K';
  return String(res);
}
function validateRut(input: string): boolean {
  const norm = normalizeRut(input);
  if (!norm) return false;
  const m = norm.match(/^(\d{7,8})-([0-9K])$/);
  if (!m) return false;
  const body = m[1]!;
  const dv = m[2]!;
  return calcRutDv(body) === dv;
}

function mapEvent(ev: any) {
  return {
    id: ev.id,
    title: ev.title,
    description: ev.description ?? '',
    startAt: (ev.date instanceof Date ? ev.date : new Date(ev.date)).toISOString(),
    endAt: null,
    venue: ev.location,
    city: ev.city ?? null,       
    commune: ev.commune ?? null, 
    capacity: ev.capacity,
    status: ev.approved ? 'approved' : 'pending',
    updatedAt:
      (ev.updatedAt instanceof Date ? ev.updatedAt : new Date(ev.updatedAt)).toISOString(),
    coverImageUrl: ev.coverImageUrl ?? null,
    price: typeof ev.price === 'number' ? ev.price : 0,
    priceBase: typeof ev.priceBase === 'number' ? ev.priceBase : null,
    eventType: ev.eventType ?? 'OWN',
    payoutBankName: ev.payoutBankName ?? null,
    payoutAccountType: ev.payoutAccountType ?? null,
    payoutAccountNumber: ev.payoutAccountNumber ?? null,
    payoutHolderName: ev.payoutHolderName ?? null,
    payoutHolderRut: ev.payoutHolderRut ?? null,
  } as const;
}

/**
 * GET /api/organizer/events
 * Query: page, pageSize, q, status
 */
export async function listMyEvents(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const page = toInt(req.query.page, 1);
  const pageSize = Math.min(50, Math.max(5, toInt(req.query.pageSize, 10)));
  const q = toStr(req.query.q);
  const status = toStr(req.query.status); // 'approved' | 'pending' | ''

  const where: any = {
    organizerId: user.id,
    ...(q ? { title: { contains: q, mode: 'insensitive' } } : {}),
    ...(status ? { approved: status === 'approved' } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.event.findMany({
      where,
      orderBy: { updatedAt: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.event.count({ where }),
  ]);

  res.json({ items: items.map(mapEvent), total, page, pageSize });
}

export async function createMyEvent(req: Request, res: Response) {
  const authed = (req as any).user as Authed;

  const {
    title,
    description,
    startAt,
    venue,
    city,       
    commune,    
    capacity,
    coverImageUrl,
    price,
    priceBase,
    eventType,
    payoutBankName,
    payoutAccountType,
    payoutAccountNumber,
    payoutHolderName,
    payoutHolderRut,
  } = req.body as {
    title: string;
    description?: string;
    startAt: string;
    venue: string;
    city?: string;       
    commune?: string;    
    capacity: number | string;
    coverImageUrl?: string | null;
    price?: number | string;
    priceBase?: number | string;
    eventType?: string;
    payoutBankName?: string | null;
    payoutAccountType?: string | null;
    payoutAccountNumber?: string | null;
    payoutHolderName?: string | null;
    payoutHolderRut?: string | null;
  };

  const config = await loadAllLimits();
  const { TICKET_LIMITS, PRICE_LIMITS, FIELD_LIMITS, ALLOWED_ACCOUNT_TYPES } = config;

  const organizer = await prisma.user.findUnique({
    where: { id: authed.id },
    select: { id: true, name: true, rut: true },
  });
  if (!organizer) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  const errors: string[] = [];

  const _title = toStr(title);
  const _startAt = toStr(startAt);
  const _venue = toStr(venue);
  const _capacityRaw = Number(capacity);

  if (!_title) errors.push('title es requerido');
  if (!_startAt) errors.push('startAt es requerido');
  if (!_venue) errors.push('venue es requerido');

  const _eventType = toStr(eventType).toUpperCase();
  const validEventTypes = new Set(['OWN', 'RESALE']);
  if (_eventType && !validEventTypes.has(_eventType)) {
    errors.push('eventType debe ser "OWN" o "RESALE"');
  }
  const finalEventType = (_eventType && validEventTypes.has(_eventType) ? _eventType : 'OWN') as 'OWN' | 'RESALE';

  if (!Number.isFinite(_capacityRaw)) {
    errors.push('capacity debe ser un entero');
  } else {
    const cap = Math.trunc(_capacityRaw);

    if (finalEventType === 'RESALE') {
      if (cap < TICKET_LIMITS.RESALE.MIN || cap > TICKET_LIMITS.RESALE.MAX) {
        errors.push(`Reventa: La cantidad de entradas debe estar entre ${TICKET_LIMITS.RESALE.MIN} y ${TICKET_LIMITS.RESALE.MAX}.`);
      }
    } else {
      if (cap < TICKET_LIMITS.OWN.MIN || cap > TICKET_LIMITS.OWN.MAX) {
        errors.push(`Evento propio: La capacidad debe estar entre ${TICKET_LIMITS.OWN.MIN} y ${TICKET_LIMITS.OWN.MAX.toLocaleString()}.`);
      }
    }
  }

  if (_title.length > FIELD_LIMITS.TITLE) errors.push(`title excede ${FIELD_LIMITS.TITLE} caracteres`);
  const _desc = toStr(description);
  if (_desc && _desc.length > FIELD_LIMITS.DESCRIPTION) errors.push(`description excede ${FIELD_LIMITS.DESCRIPTION} caracteres`);
  if (_venue.length > FIELD_LIMITS.VENUE) errors.push(`venue excede ${FIELD_LIMITS.VENUE} caracteres`);
  const _cover = toStr(coverImageUrl);
  if (_cover && _cover.length > FIELD_LIMITS.COVER_URL) errors.push(`coverImageUrl excede ${FIELD_LIMITS.COVER_URL} caracteres`);

  const _city = toStr(city);
  if (_city && _city.length > FIELD_LIMITS.CITY) errors.push(`city excede ${FIELD_LIMITS.CITY} caracteres`);
  const _commune = toStr(commune);
  if (_commune && _commune.length > FIELD_LIMITS.COMMUNE) errors.push(`commune excede ${FIELD_LIMITS.COMMUNE} caracteres`);

  let _price: number | undefined = undefined;
  if (price !== undefined) {
    const p = Number(price);
    if (!Number.isInteger(p)) errors.push('price debe ser un entero (CLP)');
    else if (p < PRICE_LIMITS.MIN || p > PRICE_LIMITS.MAX) errors.push(`price debe estar entre ${PRICE_LIMITS.MIN} y ${PRICE_LIMITS.MAX} CLP`);
    else _price = p;
  }

  let _priceBase: number | undefined = undefined;
  if (finalEventType === 'RESALE') {
    if (!priceBase) {
      errors.push('priceBase es requerido para eventos de reventa');
    } else {
      const base = Number(priceBase);
      if (!Number.isInteger(base) || base < 0) {
        errors.push('priceBase debe ser un entero (CLP) mayor o igual a 0');
      } else {
        _priceBase = base;
        if (_price !== undefined) {
          const maxAllowed = calculateMaxResalePrice(base);
          if (_price < base) errors.push('price no puede ser menor a priceBase');
          if (_price > maxAllowed) errors.push(`price no puede superar ${maxAllowed} (base + ${PRICE_LIMITS.RESALE_MARKUP_PERCENT}%)`);
        }
      }
    }
  }

  const _bank = toStr(payoutBankName);
  if (_bank && _bank.length > FIELD_LIMITS.PAYOUT_BANK) errors.push(`payoutBankName excede ${FIELD_LIMITS.PAYOUT_BANK} caracteres`);

  const _type = toStr(payoutAccountType);
  if (_type && !ALLOWED_ACCOUNT_TYPES.includes(_type as any)) errors.push('payoutAccountType invalido (corriente|vista|ahorro|rut)');
  if (_type && _type.length > FIELD_LIMITS.PAYOUT_TYPE) errors.push(`payoutAccountType excede ${FIELD_LIMITS.PAYOUT_TYPE} caracteres`);

  const _acc = toStr(payoutAccountNumber);
  if (_acc && _acc.length > FIELD_LIMITS.PAYOUT_NUMBER) errors.push(`payoutAccountNumber excede ${FIELD_LIMITS.PAYOUT_NUMBER} caracteres`);

  let _holderName = toStr(payoutHolderName);
  if (_holderName && _holderName.length > FIELD_LIMITS.PAYOUT_HOLDER_NAME) {
    errors.push(`payoutHolderName excede ${FIELD_LIMITS.PAYOUT_HOLDER_NAME} caracteres`);
  }

  let _holderRut = toStr(payoutHolderRut);
  if (_holderRut) {
    _holderRut = normalizeRut(_holderRut);
    if (!validateRut(_holderRut)) errors.push('payoutHolderRut invalido');
  }

  if (errors.length) {
    return res.status(400).json({ error: 'Datos inválidos', details: errors });
  }

  if (!_holderName) _holderName = organizer.name ?? '';
  if (!_holderRut && organizer.rut) _holderRut = organizer.rut;

  if (_holderName && _holderName.length > FIELD_LIMITS.PAYOUT_HOLDER_NAME) {
    _holderName = _holderName.slice(0, FIELD_LIMITS.PAYOUT_HOLDER_NAME);
  }

  const created = await prisma.event.create({
    data: {
      title: _title,
      description: _desc || '',
      date: new Date(_startAt),
      location: _venue,
      city: _city || null,       
      commune: _commune || null, 
      capacity: Math.trunc(_capacityRaw), // ya validado
      approved: false,
      eventType: finalEventType,
      organizerId: organizer.id,
      ...(!!_cover ? { coverImageUrl: _cover } : {}),
      ...(_price !== undefined ? { price: _price } : {}),
      ...(_priceBase !== undefined ? { priceBase: _priceBase } : {}),
      payoutBankName: _bank || null,
      payoutAccountType: _type || null,
      payoutAccountNumber: _acc || null,
      payoutHolderName: _holderName || null,
      payoutHolderRut: _holderRut || null,
    },
  });

  res.status(201).json(mapEvent(created));
}

export async function getMyEvent(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const id = Number(req.params.id);

  const ev = await prisma.event.findFirst({
    where: { id, organizerId: user.id },
  });

  if (!ev) return res.status(404).json({ error: 'No encontrado' });
  res.json(mapEvent(ev));
}

export async function updateMyEvent(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const id = Number(req.params.id);

  const exists = await prisma.event.findFirst({
    where: { id, organizerId: user.id },
    select: { id: true, approved: true, eventType: true },
  });
  if (!exists) return res.status(404).json({ error: 'No encontrado' });

  const config = await loadAllLimits();
  const { TICKET_LIMITS, PRICE_LIMITS, FIELD_LIMITS, ALLOWED_ACCOUNT_TYPES } = config;

  const {
    title,
    description,
    startAt,
    venue,
    city,       
    commune,    
    capacity,
    coverImageUrl,
    price,
    priceBase,
    payoutBankName,
    payoutAccountType,
    payoutAccountNumber,
    payoutHolderName,
    payoutHolderRut,
  } = req.body as Partial<{
    title: string;
    description: string;
    startAt: string;
    venue: string;
    city: string;       
    commune: string;    
    capacity: number | string;
    coverImageUrl: string | null;
    price: number | string;
    priceBase: number | string;
    payoutBankName: string | null;
    payoutAccountType: string | null;
    payoutAccountNumber: string | null;
    payoutHolderName: string | null;
    payoutHolderRut: string | null;
  }>;

  const errors: string[] = [];
  const data: any = { approved: false };

  if (title !== undefined) {
    const v = toStr(title);
    if (!v) errors.push('title no puede estar vacio');
    if (v.length > FIELD_LIMITS.TITLE) errors.push(`title excede ${FIELD_LIMITS.TITLE} caracteres`);
    data.title = v;
  }
  if (description !== undefined) {
    const v = toStr(description);
    if (v.length > FIELD_LIMITS.DESCRIPTION) errors.push(`description excede ${FIELD_LIMITS.DESCRIPTION} caracteres`);
    data.description = v;
  }
  if (startAt !== undefined) {
    const v = toStr(startAt);
    if (!v) errors.push('startAt no puede estar vacio');
    data.date = new Date(v);
  }
  if (venue !== undefined) {
    const v = toStr(venue);
    if (!v) errors.push('venue no puede estar vacio');
    if (v.length > FIELD_LIMITS.VENUE) errors.push(`venue excede ${FIELD_LIMITS.VENUE} caracteres`);
    data.location = v;
  }

  if (city !== undefined) {
    const v = toStr(city);
    if (v && v.length > FIELD_LIMITS.CITY) errors.push(`city excede ${FIELD_LIMITS.CITY} caracteres`);
    data.city = v || null;
  }
  if (commune !== undefined) {
    const v = toStr(commune);
    if (v && v.length > FIELD_LIMITS.COMMUNE) errors.push(`commune excede ${FIELD_LIMITS.COMMUNE} caracteres`);
    data.commune = v || null;
  }
  if (capacity !== undefined) {
    const nRaw = Number(capacity);
    if (!Number.isFinite(nRaw)) {
      errors.push('capacity debe ser un entero');
    } else {
      const n = Math.trunc(nRaw);
      
      const isResale = exists.eventType === 'RESALE';
      
      if (isResale) {
        if (n < TICKET_LIMITS.RESALE.MIN || n > TICKET_LIMITS.RESALE.MAX) {
          errors.push(`Reventa: La cantidad de entradas debe estar entre ${TICKET_LIMITS.RESALE.MIN} y ${TICKET_LIMITS.RESALE.MAX}.`);
        }
      } else {
        if (n < TICKET_LIMITS.OWN.MIN || n > TICKET_LIMITS.OWN.MAX) {
          errors.push(`Evento propio: La capacidad debe estar entre ${TICKET_LIMITS.OWN.MIN} y ${TICKET_LIMITS.OWN.MAX.toLocaleString()}.`);
        }
      }
      
      if (errors.length === 0) {
        data.capacity = n;
      }
    }
  }
  if (coverImageUrl !== undefined) {
    const v = toStr(coverImageUrl);
    if (v && v.length > FIELD_LIMITS.COVER_URL) errors.push(`coverImageUrl excede ${FIELD_LIMITS.COVER_URL} caracteres`);
    data.coverImageUrl = v || null;
  }

  let _price: number | undefined = undefined;
  if (price !== undefined) {
    const p = Number(price);
    if (!Number.isInteger(p)) errors.push('price debe ser un entero (CLP)');
    else if (p < PRICE_LIMITS.MIN || p > PRICE_LIMITS.MAX) errors.push(`price debe estar entre ${PRICE_LIMITS.MIN} y ${PRICE_LIMITS.MAX} CLP`);
    else _price = p;
  }

  let _priceBase: number | undefined = undefined;
  if (priceBase !== undefined) {
    const base = Number(priceBase);
    if (!Number.isInteger(base) || base < 0) {
      errors.push('priceBase debe ser un entero (CLP) mayor o igual a 0');
    } else {
      _priceBase = base;
      if (_price !== undefined) {
        const maxAllowed = calculateMaxResalePrice(base);
        if (_price < base) errors.push('price no puede ser menor a priceBase');
        if (_price > maxAllowed) errors.push(`price no puede superar ${maxAllowed} (base + ${PRICE_LIMITS.RESALE_MARKUP_PERCENT}%)`);
      }
    }
  }

  if (_price !== undefined) {
    data.price = _price;
  }
  if (_priceBase !== undefined) {
    data.priceBase = _priceBase;
  }

  if (payoutBankName !== undefined) {
    const v = toStr(payoutBankName);
    if (v && v.length > FIELD_LIMITS.PAYOUT_BANK) errors.push(`payoutBankName excede ${FIELD_LIMITS.PAYOUT_BANK} caracteres`);
    data.payoutBankName = v || null;
  }
  if (payoutAccountType !== undefined) {
    const v = toStr(payoutAccountType);
    if (v && !ALLOWED_ACCOUNT_TYPES.includes(v as any)) errors.push('payoutAccountType invalido (corriente|vista|ahorro|rut)');
    if (v && v.length > FIELD_LIMITS.PAYOUT_TYPE) errors.push(`payoutAccountType excede ${FIELD_LIMITS.PAYOUT_TYPE} caracteres`);
    data.payoutAccountType = v || null;
  }
  if (payoutAccountNumber !== undefined) {
    const v = toStr(payoutAccountNumber);
    if (v && v.length > FIELD_LIMITS.PAYOUT_NUMBER) errors.push(`payoutAccountNumber excede ${FIELD_LIMITS.PAYOUT_NUMBER} caracteres`);
    data.payoutAccountNumber = v || null;
  }
  if (payoutHolderName !== undefined) {
    let v = toStr(payoutHolderName);
    if (v && v.length > FIELD_LIMITS.PAYOUT_HOLDER_NAME) errors.push(`payoutHolderName excede ${FIELD_LIMITS.PAYOUT_HOLDER_NAME} caracteres`);
    data.payoutHolderName = v || null;
  }
  if (payoutHolderRut !== undefined) {
    let v = toStr(payoutHolderRut);
    if (v) {
      v = normalizeRut(v);
      if (!validateRut(v)) errors.push('payoutHolderRut invalido');
    }
    data.payoutHolderRut = v || null;
  }

  if (errors.length) {
    return res.status(400).json({ error: 'Datos inválidos', details: errors });
  }

  const updated = await prisma.event.update({
    where: { id },
    data,
  });

  const systemMessage = exists.approved
    ? 'Tu evento fue actualizado y quedo PENDIENTE de aprobación.'
    : 'Cambios guardados. El evento continua PENDIENTE de aprobación.';

  res.json({ ...mapEvent(updated), _message: systemMessage });
}

/**
 * DELETE /api/organizer/events/:id
 */
export async function deleteMyEvent(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const id = Number(req.params.id);

  const exists = await prisma.event.findFirst({ where: { id, organizerId: user.id } });
  if (!exists) return res.status(404).json({ error: 'No encontrado' });

  await prisma.event.delete({ where: { id } });
  res.status(204).send();
}









