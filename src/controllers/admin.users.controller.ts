import { Request, Response } from "express";
import prisma from "../prisma/client";

function toInt(v: unknown, def: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}
function toStr(v: unknown) {
  return String(v ?? "").trim();
}

/** Batch de estados de solicitud (optimiza /list) */
async function getLatestOrganizerAppStatuses(userIds: number[]) {
  if (userIds.length === 0) return new Map<number, string | null>();
  const rows = await prisma.organizerApplication.findMany({
    where: { userId: { in: userIds } },
    orderBy: { createdAt: "desc" },
    select: { userId: true, status: true },
  });
  const seen = new Set<number>();
  const map = new Map<number, string | null>();
  for (const r of rows) {
    if (seen.has(r.userId)) continue;
    seen.add(r.userId);
    map.set(r.userId, r.status);
  }
  for (const id of userIds) if (!map.has(id)) map.set(id, null);
  return map;
}

/**
 * Lista de usuarios con:
 * - latestOrganizerAppStatus (para la columna Solicitud)
 * - effectiveCanSell: organizer && canSell && isActive && !deletedAt
 *
 * Ya NO hay “verified” aquí.
 */
export async function adminListUsers(req: Request, res: Response) {
  const page = toInt(req.query.page, 1);
  const pageSize = Math.min(50, Math.max(5, toInt(req.query.pageSize, 10)));
  const q = toStr(req.query.q);
  const role = toStr(req.query.role);
  const canSellQ = toStr(req.query.canSell); // "true" | "false" | ""

  const where: any = {
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(role ? { role } : {}),
  };

  const needEffCanSell = canSellQ === "true" || canSellQ === "false";

  const [itemsRaw, totalRaw] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { id: "asc" },
      ...(needEffCanSell ? {} : { skip: (page - 1) * pageSize, take: pageSize }),
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        canSell: true,
        isActive: true,
        deletedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    needEffCanSell ? Promise.resolve(0) : prisma.user.count({ where }),
  ]);

  const ids = itemsRaw.map((u) => u.id);
  const lastStatusMap = await getLatestOrganizerAppStatuses(ids);
  
  // Obtener también el applicationId para usuarios con solicitudes
  const applications = await prisma.organizerApplication.findMany({
    where: { userId: { in: ids } },
    select: { userId: true, id: true },
  });
  const applicationIdMap = new Map(applications.map((a) => [a.userId, a.id]));

  const withComputed = itemsRaw.map((u) => {
    const status = lastStatusMap.get(u.id) ?? null;
    const effectiveCanSell =
      u.role === "organizer" && !!u.canSell && !!u.isActive && !u.deletedAt;

    return {
      ...u,
      latestOrganizerAppStatus: status as "PENDING" | "APPROVED" | "REJECTED" | null,
      applicationId: applicationIdMap.get(u.id) ?? null,
      effectiveCanSell,
    };
  });

  if (needEffCanSell) {
    const want = canSellQ === "true";
    const filtered = withComputed.filter((u) => u.effectiveCanSell === want);
    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);
    return res.json({ items, total, page, pageSize });
  }

  return res.json({
    items: withComputed,
    total: totalRaw,
    page,
    pageSize,
  });
}

/**
 * GET /api/admin/users/:id
 * Obtiene los detalles completos de un usuario específico
 */
export async function adminGetUser(req: Request, res: Response) {
  const id = Number(req.params.id);

  // validar id
  if (!id || id <= 0) {
    return res.status(400).json({ error: "ID de usuario inválido" });
  }

  // objeto con la informacion del usuario
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      rut: true,
      birthDate: true,
      canSell: true,
      isVerified: true,
      isActive: true,
      deletedAt: true,
      anonymizedAt: true,
      documentUrl: true,
      failedLoginCount: true,
      lockUntil: true,
      createdAt: true,
      updatedAt: true,
      // informacion de la solicitud para ser organizador
      application: {
        select: {
          id: true,
          legalName: true,
          taxId: true,
          phone: true,
          idCardImage: true,
          idCardImageBack: true,
          notes: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          // Datos bancarios de la solicitud
          payoutBankName: true,
          payoutAccountType: true,
          payoutAccountNumber: true,
          payoutHolderName: true,
          payoutHolderRut: true,
        },
      },
      // Información bancaria
      connectedAccount: {
        select: {
          id: true,
          psp: true,
          pspAccountId: true,
          onboardingStatus: true,
          payoutsEnabled: true,
          payoutBankName: true,
          payoutAccountType: true,
          payoutAccountNumber: true,
          payoutHolderName: true,
          payoutHolderRut: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  if (!user) {
    return res.status(404).json({ error: "Usuario no encontrado" });
  }

  // Obtener estadisticas del usuario
  const [eventsCount, reservationsCount, activeEventsCount] = await Promise.all([
    // Total de eventos creados
    prisma.event.count({ where: { organizerId: id } }),
    // Total de reservas/compras realizadas
    prisma.reservation.count({ where: { buyerId: id } }),
    // Eventos activos (aprobados y no vencidos)
    prisma.event.count({
      where: {
        organizerId: id,
        approved: true,
        date: { gte: new Date() }, // eventos futuros
      },
    }),
  ]);

  // verificar si esta habilitado para venta
  const effectiveCanSell =
    user.role === "organizer" && !!user.canSell && !!user.isActive && !user.deletedAt;

  // formatear información bancaria
  // Primero intenta usar ConnectedAccount, luego los datos de la Application
  let bankingInfo = null;
  
  if (user.connectedAccount) {
    // Usuario tiene cuenta conectada (organizador aprobado)
    bankingInfo = {
      hasBankAccount: !!(
        user.connectedAccount.payoutBankName &&
        user.connectedAccount.payoutAccountNumber
      ),
      payoutsEnabled: user.connectedAccount.payoutsEnabled,
      bankDetails: {
        bankName: user.connectedAccount.payoutBankName,
        accountType: user.connectedAccount.payoutAccountType,
        accountNumber: user.connectedAccount.payoutAccountNumber,
        holderName: user.connectedAccount.payoutHolderName,
        holderRut: user.connectedAccount.payoutHolderRut,
      },
      createdAt: user.connectedAccount.createdAt,
      updatedAt: user.connectedAccount.updatedAt,
    };
  } else if (user.application?.payoutBankName) {
    // Usuario tiene solicitud pendiente con datos bancarios
    bankingInfo = {
      hasBankAccount: !!(
        user.application.payoutBankName &&
        user.application.payoutAccountNumber
      ),
      payoutsEnabled: false, // No habilitado hasta ser aprobado
      bankDetails: {
        bankName: user.application.payoutBankName,
        accountType: user.application.payoutAccountType,
        accountNumber: user.application.payoutAccountNumber,
        holderName: user.application.payoutHolderName,
        holderRut: user.application.payoutHolderRut,
      },
      createdAt: user.application.createdAt,
      updatedAt: user.application.updatedAt,
    };
  }

  res.json({
    ...user,
    // incluir las URLs completas de las imágenes de cédula si existen
    application: user.application ? {
      ...user.application,
      idCardImageUrl: user.application.idCardImage 
        ? `/api/admin/documents/${user.application.idCardImage}`
        : null,
      idCardImageBackUrl: user.application.idCardImageBack 
        ? `/api/admin/documents/${user.application.idCardImageBack}`
        : null,
    } : null,
    stats: {
      eventsCreated: eventsCount,
      purchasesMade: reservationsCount,
      activeEvents: activeEventsCount,
    },
    // estado de permisos
    effectiveCanSell,
    // estado de la solicitud de organizador
    latestOrganizerAppStatus: user.application?.status ?? null,
    // informacion bancaria
    bankingInfo,
  });
}

/* ========== Acciones principales que sí usamos ========== */

export async function adminSetUserCanSell(req: Request, res: Response) {
  const id = Number(req.params.id);
  const { canSell } = req.body as { canSell: boolean };

  const user = await prisma.user.findUnique({
    where: { id },
    select: { role: true, deletedAt: true, isActive: true },
  });
  if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
  if (user.role !== "organizer") {
    return res.status(409).json({ error: "Solo usuarios con rol organizer pueden vender." });
  }
  if (user.deletedAt || !user.isActive) {
    return res.status(409).json({ error: "No puedes habilitar venta en cuentas inactivas o eliminadas." });
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { canSell: Boolean(canSell) },
    select: {
      id: true, name: true, email: true, role: true,
      canSell: true, isActive: true, deletedAt: true,
      createdAt: true, updatedAt: true,
    },
  });

  const lastStatusMap = await getLatestOrganizerAppStatuses([id]);
  const latestOrganizerAppStatus = lastStatusMap.get(id) ?? null;
  const effectiveCanSell =
    updated.role === "organizer" && !!updated.canSell && !!updated.isActive && !updated.deletedAt;

  res.json({ ...updated, latestOrganizerAppStatus, effectiveCanSell });
}

export async function adminDeactivateUser(req: Request, res: Response) {
  const id = Number(req.params.id);
  const updated = await prisma.user.update({
    where: { id },
    data: { isActive: false, canSell: false },
    select: {
      id: true, name: true, email: true, role: true,
      canSell: true, isActive: true, deletedAt: true,
      createdAt: true, updatedAt: true,
    },
  });

  const lastStatusMap = await getLatestOrganizerAppStatuses([id]);
  res.json({
    ...updated,
    latestOrganizerAppStatus: lastStatusMap.get(id) ?? null,
    effectiveCanSell: false,
  });
}

export async function adminActivateUser(req: Request, res: Response) {
  const id = Number(req.params.id);
  const updated = await prisma.user.update({
    where: { id },
    data: { isActive: true },
    select: {
      id: true, name: true, email: true, role: true,
      canSell: true, isActive: true, deletedAt: true,
      createdAt: true, updatedAt: true,
    },
  });

  const lastStatusMap = await getLatestOrganizerAppStatuses([id]);
  const latestOrganizerAppStatus = lastStatusMap.get(id) ?? null;
  const effectiveCanSell =
    updated.role === "organizer" && !!updated.canSell && !!updated.isActive && !updated.deletedAt;

  res.json({ ...updated, latestOrganizerAppStatus, effectiveCanSell });
}

export async function adminDeleteUserPreview(req: Request, res: Response) {
  const id = Number(req.params.id);

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, role: true, isActive: true },
  });
  if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

  const [eventsOwned, reservationsMade, organizerApplications] = await Promise.all([
    prisma.event.count({ where: { organizerId: id } }),
    prisma.reservation.count({ where: { buyerId: id } }),
    prisma.organizerApplication.count({ where: { userId: id } }),
  ]);

  res.json({
    user,
    counts: { eventsOwned, reservationsMade, organizerApplications },
    hasData: eventsOwned + reservationsMade + organizerApplications > 0,
  });
}

export async function adminSoftDeleteUser(req: Request, res: Response) {
  const id = Number(req.params.id);
  const now = new Date();
  const anonymEmail = `${id}.${now.getTime()}+deleted@invalid.local`;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id },
        data: {
          isActive: false,
          deletedAt: now,
          canSell: false,
          name: "Cuenta eliminada",
          email: anonymEmail,
          documentUrl: null,
        },
        select: {
          id: true, name: true, email: true, role: true,
          canSell: true, isActive: true, deletedAt: true,
          createdAt: true, updatedAt: true,
        },
      });

      await tx.organizerApplication.updateMany({
        where: { userId: id, status: { in: ["PENDING", "APPROVED"] } },
        data: { status: "REJECTED" },
      });

      const eventsRes = await tx.event.updateMany({
        where: { organizerId: id },
        data: { approved: false },
      });

      return { user, eventsDisabled: eventsRes.count };
    });

    const lastStatusMap = await getLatestOrganizerAppStatuses([id]);
    return res.json({
      message: "Cuenta eliminada (soft) y eventos inhabilitados",
      user: result.user,
      eventsDisabled: result.eventsDisabled,
      latestOrganizerAppStatus: lastStatusMap.get(id) ?? null,
      effectiveCanSell: false,
    });
  } catch (err) {
    console.error("Soft delete error:", err);
    return res.status(500).json({ error: "No se pudo eliminar la cuenta" });
  }
}









