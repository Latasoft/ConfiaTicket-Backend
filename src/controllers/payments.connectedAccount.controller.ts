// src/controllers/payments.connectedAccount.controller.ts
import { Request, Response } from "express";
import prisma from "../prisma/client";

/**
 * Asumimos que el middleware de auth inyecta:
 *   req.user = { id: number; role: 'organizer' | 'buyer' | 'superadmin' }
 */

type AccountType = "VISTA" | "CORRIENTE" | "AHORRO" | "RUT";

// Placeholder para cuentas locales (sin onboarding real del PSP todavía)
const DEFAULT_PSP = "LOCAL";
const makeLocalPspId = (userId: number) => `LOCAL-${userId}`;

// Aceptamos variantes con y sin espacio para Banco Estado
const BANKS_CL = new Set([
  "Banco Estado",
  "BancoEstado",
  "Banco de Chile",
  "BCI",
  "Scotiabank",
  "Itaú",
  "Banco Santander",
  "Banco BICE",
  "Banco Falabella",
  "Banco Security",
  "Banco Ripley",
  "Banco Consorcio",
  "Banco Internacional",
  "Banco BTG Pactual",
  "Banco Edwards",
]);

/* ----------------------------- Utils comunes ----------------------------- */

function toStr(v: unknown) {
  return String(v ?? "").trim();
}
function toBool(v: unknown) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "true" || s === "1" || s === "on") return true;
  if (s === "false" || s === "0" || s === "off") return false;
  return false;
}

// Normaliza BancoEstado -> Banco Estado
function normalizeBankName(v: string) {
  const s = toStr(v);
  if (s === "BancoEstado") return "Banco Estado";
  return s;
}

function cleanRut(v: string) {
  return (v || "").replace(/[.\-]/g, "").trim().toUpperCase();
}
function isValidRut(v: string) {
  const s = cleanRut(v);
  if (!/^\d{1,8}[0-9K]$/.test(s)) return false;
  const cuerpo = s.slice(0, -1);
  const dv = s.slice(-1);
  let m = 0,
    r = 1;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    r = (r + Number(cuerpo[i]) * (9 - (m++ % 6))) % 11;
  }
  const dvCalc = r ? String(r - 1) : "K";
  return dv === dvCalc;
}
function parseAccountType(v: unknown): AccountType | null {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "VISTA" || s === "CORRIENTE" || s === "AHORRO" || s === "RUT") return s as AccountType;
  return null;
}
function onlyDigits(v: string) {
  return (v || "").replace(/\D/g, "");
}

function currentUserId(req: Request): number | null {
  const id = (req as any)?.user?.id;
  const n = Number(id);
  return Number.isFinite(n) ? n : null;
}

/** ✅ Verifica en BD si el usuario es organizador aprobado
 *  Criterio: role === 'organizer' Y (isVerified === true  O  application.status === 'APPROVED')
 */
async function isOrganizerApprovedByDb(req: Request): Promise<boolean> {
  const userId = currentUserId(req);
  if (!userId) return false;

  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      isVerified: true,
      application: { select: { status: true } },
    },
  });

  if (!u) return false;
  const approvedByApp = u.application?.status === "APPROVED";
  return u.role === "organizer" && (u.isVerified === true || approvedByApp);
}

const accountSelect = {
  payoutsEnabled: true,
  payoutBankName: true,
  payoutAccountType: true,
  payoutAccountNumber: true,
  payoutHolderName: true,
  payoutHolderRut: true,
  updatedAt: true,
  // extra para depurar
  psp: true,
  pspAccountId: true,
} as const;

type AccountShape = {
  payoutsEnabled: boolean;
  payoutBankName: string | null;
  payoutAccountType: AccountType | null;
  payoutAccountNumber: string | null;
  payoutHolderName: string | null;
  payoutHolderRut: string | null;
};

function isAccountComplete(acc: AccountShape): boolean {
  if (!acc) return false;
  if (!acc.payoutBankName || !BANKS_CL.has(acc.payoutBankName)) return false;
  if (!acc.payoutAccountType) return false;
  if (!acc.payoutAccountNumber || !/^\d{7,14}$/.test(acc.payoutAccountNumber)) return false;
  if (!acc.payoutHolderName || !/^[A-ZÁÉÍÓÚÜÑa-záéíóúüñ ]{2,60}$/.test(acc.payoutHolderName.trim()))
    return false;
  if (!acc.payoutHolderRut || !isValidRut(acc.payoutHolderRut)) return false;
  return true;
}

/* --------------------------------- GET ---------------------------------- */
/**
 * GET /api/payments/connected-account
 * - Requiere organizer APROBADO.
 * - Si no existe registro, lo crea con payoutsEnabled=false y campos nulos.
 *   (Incluimos psp/pspAccountId obligatorios del schema.)
 */
export async function getMyConnectedAccount(req: Request, res: Response) {
  try {
    if (!(await isOrganizerApprovedByDb(req))) {
      return res.status(403).json({ error: "FORBIDDEN", message: "No autorizado o no aprobado como organizador." });
    }
    const uid = currentUserId(req);
    if (!uid) return res.status(401).json({ error: "UNAUTHORIZED" });

    // Busca o crea
    let acc = await prisma.connectedAccount.findUnique({
      where: { userId: uid },
      select: accountSelect,
    });

    if (!acc) {
      await prisma.connectedAccount.create({
        data: {
          userId: uid,
          payoutsEnabled: false,
          psp: DEFAULT_PSP,
          pspAccountId: makeLocalPspId(uid),
        },
      });
      acc = await prisma.connectedAccount.findUnique({
        where: { userId: uid },
        select: accountSelect,
      });
    }

    if (!acc) {
      return res.status(500).json({ error: "ACCOUNT_NOT_FOUND" });
    }

    const payoutsReady = !!(acc.payoutsEnabled && isAccountComplete(acc));
    return res.json({ ...acc, payoutsReady });
  } catch (err) {
    console.error("getMyConnectedAccount error:", err);
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
}

/* -------------------------------- PATCH --------------------------------- */
/**
 * PATCH /api/payments/connected-account
 * - Requiere organizer APROBADO.
 * - Valida campos; si se quiere habilitar payouts, todos los campos deben ser válidos.
 */
export async function updateMyConnectedAccount(req: Request, res: Response) {
  try {
    if (!(await isOrganizerApprovedByDb(req))) {
      return res.status(403).json({ error: "FORBIDDEN", message: "No autorizado o no aprobado como organizador." });
    }
    const uid = currentUserId(req);
    if (!uid) return res.status(401).json({ error: "UNAUTHORIZED" });

    // Asegura que exista el registro (con psp/pspAccountId)
    let acc = await prisma.connectedAccount.findUnique({
      where: { userId: uid },
      select: { id: true },
    });
    if (!acc) {
      acc = await prisma.connectedAccount.create({
        data: {
          userId: uid,
          payoutsEnabled: false,
          psp: DEFAULT_PSP,
          pspAccountId: makeLocalPspId(uid),
        },
        select: { id: true },
      });
    }

    // Normalización de entrada
    const payoutsEnabled = req.body.hasOwnProperty("payoutsEnabled")
      ? toBool(req.body.payoutsEnabled)
      : undefined;

    const payoutBankName = req.body.hasOwnProperty("payoutBankName")
      ? normalizeBankName(req.body.payoutBankName)
      : undefined;

    const payoutAccountTypeRaw = req.body.hasOwnProperty("payoutAccountType")
      ? req.body.payoutAccountType
      : undefined;
    const payoutAccountType =
      payoutAccountTypeRaw === null || payoutAccountTypeRaw === ""
        ? null
        : parseAccountType(payoutAccountTypeRaw);

    const payoutAccountNumber = req.body.hasOwnProperty("payoutAccountNumber")
      ? onlyDigits(toStr(req.body.payoutAccountNumber))
      : undefined;

    const payoutHolderName = req.body.hasOwnProperty("payoutHolderName")
      ? toStr(req.body.payoutHolderName)
      : undefined;

    const payoutHolderRutRaw = req.body.hasOwnProperty("payoutHolderRut")
      ? toStr(req.body.payoutHolderRut)
      : undefined;
    const payoutHolderRut =
      payoutHolderRutRaw === undefined ? undefined : cleanRut(payoutHolderRutRaw);

    // Validaciones
    const errors: Record<string, string> = {};

    function requireIfEnabled(field: string, cond: boolean, msg: string) {
      if (payoutsEnabled === true && cond) errors[field] = msg;
    }

    // Banco
    if (payoutBankName !== undefined) {
      if (payoutBankName === "" || !BANKS_CL.has(payoutBankName)) {
        errors.payoutBankName = "Selecciona un banco válido.";
      }
    } else {
      requireIfEnabled("payoutBankName", true, "Campo obligatorio.");
    }

    // Tipo de cuenta
    if (payoutAccountTypeRaw !== undefined) {
      if (payoutAccountType === null) {
        errors.payoutAccountType = "Selecciona el tipo de cuenta.";
      }
    } else {
      requireIfEnabled("payoutAccountType", true, "Campo obligatorio.");
    }

    // Número de cuenta
    if (payoutAccountNumber !== undefined) {
      if (!/^\d{7,14}$/.test(payoutAccountNumber)) {
        errors.payoutAccountNumber = "Ingresa solo dígitos (7–14).";
      }
    } else {
      requireIfEnabled("payoutAccountNumber", true, "Campo obligatorio.");
    }

    // Titular
    if (payoutHolderName !== undefined) {
      const ok = /^[A-ZÁÉÍÓÚÜÑa-záéíóúüñ ]{2,60}$/.test(payoutHolderName.trim());
      if (!ok) errors.payoutHolderName = "Ingresa un nombre válido (2–60 caracteres).";
    } else {
      requireIfEnabled("payoutHolderName", true, "Campo obligatorio.");
    }

    // RUT
    if (payoutHolderRut !== undefined) {
      if (!isValidRut(payoutHolderRut)) {
        errors.payoutHolderRut = "RUT inválido.";
      }
    } else {
      requireIfEnabled("payoutHolderRut", true, "Campo obligatorio.");
    }

    if (Object.keys(errors).length > 0) {
      return res.status(422).json({ error: "VALIDATION_ERROR", errors });
    }

    // Construcción del payload de actualización (manteniendo nulls cuando corresponda)
    const data: any = {};
    if (payoutsEnabled !== undefined) data.payoutsEnabled = payoutsEnabled;
    if (payoutBankName !== undefined) data.payoutBankName = payoutBankName || null;
    if (payoutAccountTypeRaw !== undefined)
      data.payoutAccountType = payoutAccountType; // puede ser null
    if (payoutAccountNumber !== undefined)
      data.payoutAccountNumber = payoutAccountNumber || null;
    if (payoutHolderName !== undefined) data.payoutHolderName = payoutHolderName || null;
    if (payoutHolderRut !== undefined) data.payoutHolderRut = payoutHolderRut || null;

    await prisma.connectedAccount.update({
      where: { userId: uid },
      data,
    });

    const updated = await prisma.connectedAccount.findUnique({
      where: { userId: uid },
      select: accountSelect,
    });

    if (!updated) {
      return res.status(500).json({ error: "ACCOUNT_NOT_FOUND" });
    }

    const payoutsReady = !!(updated.payoutsEnabled && isAccountComplete(updated));
    return res.json({ ...updated, payoutsReady });
  } catch (err) {
    console.error("updateMyConnectedAccount error:", err);
    return res.status(500).json({ error: "INTERNAL_ERROR" });
  }
}




