// src/controllers/organizer.events.controller.ts
import { Request, Response } from 'express';
import prisma from '../prisma/client';

type Authed = { id: number; role: string };

/* ================== Helpers básicos ================== */
function toInt(val: unknown, def: number) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}
function toStr(v: unknown) {
  return String(v ?? '').trim();
}

/* =============== Límites de longitud (DB) =============== */
const LIMITS = {
  TITLE: 120,
  DESC: 4000,
  VENUE: 120,
  COVER: 1024,

  PAY_BANK: 80,
  PAY_TYPE: 16,          // "corriente" | "vista" | "ahorro" | "rut"
  PAY_NUMBER: 30,
  PAY_HOLDER_NAME: 100,
  PAY_HOLDER_RUT: 16,
};

const ALLOWED_ACCOUNT_TYPES = new Set(['corriente', 'vista', 'ahorro', 'rut']);

/* ======== Reventa personal: límite de entradas ======== */
const RESELL_MIN = 1;
const RESELL_MAX = 4;

/* ======== Precio (CLP enteros, no negativo) ======== */
const PRICE_MIN = 0;
const PRICE_MAX = 10_000_000; // límite sanitario para evitar valores absurdos

/* ===================== RUT utils ===================== */
// Normaliza a "XXXXXXXX-D" (sin puntos; guion antes del DV; DV en mayúscula).
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

/* ========== Mapper DB Event -> DTO frontend ========== */
function mapEvent(ev: any) {
  return {
    id: ev.id,
    title: ev.title,
    description: ev.description ?? '',
    startAt: (ev.date instanceof Date ? ev.date : new Date(ev.date)).toISOString(),
    endAt: null, // no existe en schema
    venue: ev.location,
    city: undefined, // no existe en schema
    capacity: ev.capacity,
    status: ev.approved ? 'approved' : 'pending',
    updatedAt:
      (ev.updatedAt instanceof Date ? ev.updatedAt : new Date(ev.updatedAt)).toISOString(),
    coverImageUrl: ev.coverImageUrl ?? null,

    // 💲 Precio (CLP enteros)
    price: typeof ev.price === 'number' ? ev.price : 0,

    // Datos de pago (opcionales)
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

/**
 * POST /api/organizer/events
 * Body: {
 *   title, description?, startAt, venue, capacity, coverImageUrl?,
 *   price?,  // 💲 CLP entero
 *   // opcional SOLO para validar reventa en backend:
 *   priceBase?, // CLP (si viene, exigimos: price ≥ base y ≤ floor(base*1.3))
 *   payoutBankName?, payoutAccountType?, payoutAccountNumber?,
 *   payoutHolderName?, payoutHolderRut?
 * }
 * -> approved SIEMPRE false (pendiente)
 */
export async function createMyEvent(req: Request, res: Response) {
  const authed = (req as any).user as Authed;

  const {
    title,
    description,
    startAt,
    venue,
    capacity,
    coverImageUrl,

    price,       // ⬅️ persiste
    priceBase,   // ⬅️ NO se persiste (solo validación)

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
    capacity: number | string;
    coverImageUrl?: string | null;

    price?: number | string;     // CLP
    priceBase?: number | string; // CLP (opcional, validación reventa)

    payoutBankName?: string | null;
    payoutAccountType?: string | null;
    payoutAccountNumber?: string | null;
    payoutHolderName?: string | null;
    payoutHolderRut?: string | null;
  };

  // Traemos datos del organizador para autocompletar si faltan
  const organizer = await prisma.user.findUnique({
    where: { id: authed.id },
    select: { id: true, name: true, rut: true },
  });
  if (!organizer) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  const errors: string[] = [];

  // Requeridos + tipos
  const _title = toStr(title);
  const _startAt = toStr(startAt);
  const _venue = toStr(venue);
  const _capacityRaw = Number(capacity);

  if (!_title) errors.push('title es requerido');
  if (!_startAt) errors.push('startAt es requerido');
  if (!_venue) errors.push('venue es requerido');

  // Capacidad 1..4 (reventa)
  if (!Number.isFinite(_capacityRaw)) {
    errors.push('capacity debe ser un entero');
  } else {
    const cap = Math.trunc(_capacityRaw);
    if (cap < RESELL_MIN || cap > RESELL_MAX) {
      errors.push(`La cantidad de entradas debe estar entre ${RESELL_MIN} y ${RESELL_MAX}.`);
    }
  }

  // Longitudes
  if (_title.length > LIMITS.TITLE) errors.push(`title excede ${LIMITS.TITLE} caracteres`);
  const _desc = toStr(description);
  if (_desc && _desc.length > LIMITS.DESC) errors.push(`description excede ${LIMITS.DESC} caracteres`);
  if (_venue.length > LIMITS.VENUE) errors.push(`venue excede ${LIMITS.VENUE} caracteres`);
  const _cover = toStr(coverImageUrl);
  if (_cover && _cover.length > LIMITS.COVER) errors.push(`coverImageUrl excede ${LIMITS.COVER} caracteres`);

  // 💲 Precio (opcional). Si viene, validar CLP entero y rango sanitario.
  let _price: number | undefined = undefined;
  if (price !== undefined) {
    const p = Number(price);
    if (!Number.isInteger(p)) errors.push('price debe ser un entero (CLP)');
    else if (p < PRICE_MIN || p > PRICE_MAX) errors.push(`price debe estar entre ${PRICE_MIN} y ${PRICE_MAX} CLP`);
    else _price = p;
  }

  // 🧮 Validación de reventa si llega priceBase en la request
  if (priceBase !== undefined && _price !== undefined) {
    const base = Number(priceBase);
    if (!Number.isInteger(base) || base < 0) {
      errors.push('priceBase debe ser un entero (CLP) ≥ 0');
    } else {
      const maxAllowed = Math.floor(base * 1.3);
      if (_price < base) errors.push('price no puede ser menor a priceBase');
      if (_price > maxAllowed) errors.push(`price no puede superar ${maxAllowed} (base + 30%)`);
    }
  }

  // Pago (opcionales)
  const _bank = toStr(payoutBankName);
  if (_bank && _bank.length > LIMITS.PAY_BANK) errors.push(`payoutBankName excede ${LIMITS.PAY_BANK} caracteres`);

  const _type = toStr(payoutAccountType);
  if (_type && !ALLOWED_ACCOUNT_TYPES.has(_type)) errors.push('payoutAccountType inválido (corriente|vista|ahorro|rut)');
  if (_type && _type.length > LIMITS.PAY_TYPE) errors.push(`payoutAccountType excede ${LIMITS.PAY_TYPE} caracteres`);

  const _acc = toStr(payoutAccountNumber);
  if (_acc && _acc.length > LIMITS.PAY_NUMBER) errors.push(`payoutAccountNumber excede ${LIMITS.PAY_NUMBER} caracteres`);

  let _holderName = toStr(payoutHolderName);
  if (_holderName && _holderName.length > LIMITS.PAY_HOLDER_NAME) {
    errors.push(`payoutHolderName excede ${LIMITS.PAY_HOLDER_NAME} caracteres`);
  }

  let _holderRut = toStr(payoutHolderRut);
  if (_holderRut) {
    _holderRut = normalizeRut(_holderRut);
    if (!validateRut(_holderRut)) errors.push('payoutHolderRut inválido');
  }

  if (errors.length) {
    return res.status(400).json({ error: 'Datos inválidos', details: errors });
  }

  // Auto-rellenar titular si no viene
  if (!_holderName) _holderName = organizer.name ?? '';
  if (!_holderRut && organizer.rut) _holderRut = organizer.rut;

  // Ajuste final por si el auto-relleno supera límites
  if (_holderName && _holderName.length > LIMITS.PAY_HOLDER_NAME) {
    _holderName = _holderName.slice(0, LIMITS.PAY_HOLDER_NAME);
  }

  const created = await prisma.event.create({
    data: {
      title: _title,
      description: _desc || '',
      date: new Date(_startAt),
      location: _venue,
      capacity: Math.trunc(_capacityRaw), // ya validado 1..4
      approved: false,
      organizerId: organizer.id,
      ...(!!_cover ? { coverImageUrl: _cover } : {}),

      // 💲 persistimos si vino (si no, conservará el default del schema)
      ...(_price !== undefined ? { price: _price } : {}),

      payoutBankName: _bank || null,
      payoutAccountType: _type || null,
      payoutAccountNumber: _acc || null,
      payoutHolderName: _holderName || null,
      payoutHolderRut: _holderRut || null,
    },
  });

  res.status(201).json(mapEvent(created));
}

/**
 * GET /api/organizer/events/:id
 */
export async function getMyEvent(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const id = Number(req.params.id);

  const ev = await prisma.event.findFirst({
    where: { id, organizerId: user.id },
  });

  if (!ev) return res.status(404).json({ error: 'No encontrado' });
  res.json(mapEvent(ev));
}

/**
 * PUT /api/organizer/events/:id
 * Body parcial: { title?, description?, startAt?, venue?, capacity?, coverImageUrl?, price?, priceBase?,
 *                 payoutBankName?, payoutAccountType?, payoutAccountNumber?,
 *                 payoutHolderName?, payoutHolderRut? }
 *
 * ⚠️ Si el organizador edita, el evento vuelve a "pending"
 */
export async function updateMyEvent(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const id = Number(req.params.id);

  const exists = await prisma.event.findFirst({
    where: { id, organizerId: user.id },
    select: { id: true, approved: true, price: true },
  });
  if (!exists) return res.status(404).json({ error: 'No encontrado' });

  const {
    title,
    description,
    startAt,
    venue,
    capacity,
    coverImageUrl,

    price,      // ⬅️ NUEVO
    priceBase,  // ⬅️ validación reventa si viene

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

  // Campos de evento (si vienen, validarlos)
  if (title !== undefined) {
    const v = toStr(title);
    if (!v) errors.push('title no puede estar vacío');
    if (v.length > LIMITS.TITLE) errors.push(`title excede ${LIMITS.TITLE} caracteres`);
    data.title = v;
  }
  if (description !== undefined) {
    const v = toStr(description);
    if (v.length > LIMITS.DESC) errors.push(`description excede ${LIMITS.DESC} caracteres`);
    data.description = v;
  }
  if (startAt !== undefined) {
    const v = toStr(startAt);
    if (!v) errors.push('startAt no puede estar vacío');
    data.date = new Date(v);
  }
  if (venue !== undefined) {
    const v = toStr(venue);
    if (!v) errors.push('venue no puede estar vacío');
    if (v.length > LIMITS.VENUE) errors.push(`venue excede ${LIMITS.VENUE} caracteres`);
    data.location = v;
  }
  if (capacity !== undefined) {
    const nRaw = Number(capacity);
    if (!Number.isFinite(nRaw)) {
      errors.push('capacity debe ser un entero');
    } else {
      const n = Math.trunc(nRaw);
      if (n < RESELL_MIN || n > RESELL_MAX) {
        errors.push(`La cantidad de entradas debe estar entre ${RESELL_MIN} y ${RESELL_MAX}.`);
      } else {
        data.capacity = n;
      }
    }
  }
  if (coverImageUrl !== undefined) {
    const v = toStr(coverImageUrl);
    if (v && v.length > LIMITS.COVER) errors.push(`coverImageUrl excede ${LIMITS.COVER} caracteres`);
    data.coverImageUrl = v || null; // permitir limpiar
  }

  // 💲 Precio (si viene, validar)
  let _price: number | undefined = undefined;
  if (price !== undefined) {
    const p = Number(price);
    if (!Number.isInteger(p)) errors.push('price debe ser un entero (CLP)');
    else if (p < PRICE_MIN || p > PRICE_MAX) errors.push(`price debe estar entre ${PRICE_MIN} y ${PRICE_MAX} CLP`);
    else _price = p;
  }

  // 🧮 Validación de reventa si llega priceBase en la request junto con price
  if (priceBase !== undefined && _price !== undefined) {
    const base = Number(priceBase);
    if (!Number.isInteger(base) || base < 0) {
      errors.push('priceBase debe ser un entero (CLP) ≥ 0');
    } else {
      const maxAllowed = Math.floor(base * 1.3);
      if (_price < base) errors.push('price no puede ser menor a priceBase');
      if (_price > maxAllowed) errors.push(`price no puede superar ${maxAllowed} (base + 30%)`);
    }
  }

  if (_price !== undefined) {
    data.price = _price;
  }

  // Pago (opcionales)
  if (payoutBankName !== undefined) {
    const v = toStr(payoutBankName);
    if (v && v.length > LIMITS.PAY_BANK) errors.push(`payoutBankName excede ${LIMITS.PAY_BANK} caracteres`);
    data.payoutBankName = v || null;
  }
  if (payoutAccountType !== undefined) {
    const v = toStr(payoutAccountType);
    if (v && !ALLOWED_ACCOUNT_TYPES.has(v)) errors.push('payoutAccountType inválido (corriente|vista|ahorro|rut)');
    if (v && v.length > LIMITS.PAY_TYPE) errors.push(`payoutAccountType excede ${LIMITS.PAY_TYPE} caracteres`);
    data.payoutAccountType = v || null;
  }
  if (payoutAccountNumber !== undefined) {
    const v = toStr(payoutAccountNumber);
    if (v && v.length > LIMITS.PAY_NUMBER) errors.push(`payoutAccountNumber excede ${LIMITS.PAY_NUMBER} caracteres`);
    data.payoutAccountNumber = v || null;
  }
  if (payoutHolderName !== undefined) {
    let v = toStr(payoutHolderName);
    if (v && v.length > LIMITS.PAY_HOLDER_NAME) errors.push(`payoutHolderName excede ${LIMITS.PAY_HOLDER_NAME} caracteres`);
    data.payoutHolderName = v || null;
  }
  if (payoutHolderRut !== undefined) {
    let v = toStr(payoutHolderRut);
    if (v) {
      v = normalizeRut(v);
      if (!validateRut(v)) errors.push('payoutHolderRut inválido');
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
    ? 'Tu evento fue actualizado y quedó PENDIENTE de aprobación.'
    : 'Cambios guardados. El evento continúa PENDIENTE de aprobación.';

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









