// src/controllers/admin.users.controller.ts
import { Request, Response } from "express";
import prisma from "../prisma/client";

function toInt(v: unknown, def: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}
function toStr(v: unknown) {
  return String(v ?? "").trim();
}

/**
 * Devuelve el estado de la última solicitud de organizador para un usuario.
 * Si no existe, retorna null.
 */
async function getLatestOrganizerAppStatus(userId: number) {
  const last = await prisma.organizerApplication.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { status: true }, // "PENDING" | "APPROVED" | "REJECTED"
  });
  return last?.status ?? null;
}

/**
 * Versión batch para varios usuarios (optimiza /list).
 */
async function getLatestOrganizerAppStatuses(userIds: number[]) {
  if (userIds.length === 0) return new Map<number, string | null>();
  const rows = await prisma.organizerApplication.findMany({
    where: { userId: { in: userIds } },
    orderBy: { createdAt: "desc" },
    select: { userId: true, status: true },
  });
  // Nos quedamos con la primera aparición por userId (ya vienen ordenadas desc por createdAt)
  const seen = new Set<number>();
  const map = new Map<number, string | null>();
  for (const r of rows) {
    if (seen.has(r.userId)) continue;
    seen.add(r.userId);
    map.set(r.userId, r.status);
  }
  // Asegurar keys faltantes
  for (const id of userIds) {
    if (!map.has(id)) map.set(id, null);
  }
  return map;
}

export async function adminListUsers(req: Request, res: Response) {
  const page = toInt(req.query.page, 1);
  const pageSize = Math.min(50, Math.max(5, toInt(req.query.pageSize, 10)));
  const q = toStr(req.query.q);
  const role = toStr(req.query.role);
  const verified = toStr(req.query.verified); // "true" | "false" | ""
  const canSell = toStr(req.query.canSell);   // "true" | "false" | ""

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
    ...(verified ? { isVerified: verified === "true" } : {}),
    ...(canSell ? { canSell: canSell === "true" } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { id: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isVerified: true,
        canSell: true,
        isActive: true,
        deletedAt: true,
        createdAt: true, // 👈 ya venía
        updatedAt: true,
      },
    }),
    prisma.user.count({ where }),
  ]);

  const ids = items.map(u => u.id);
  const latestMap = await getLatestOrganizerAppStatuses(ids);

  const itemsWithApp = items.map((u) => ({
    ...u,
    latestOrganizerAppStatus: latestMap.get(u.id) ?? null,
  }));

  res.json({ items: itemsWithApp, total, page, pageSize });
}

export async function adminSetUserVerified(req: Request, res: Response) {
  const id = Number(req.params.id);
  const { isVerified } = req.body as { isVerified: boolean };

  // Impedir verificar si no hay solicitud aprobada
  if (isVerified === true) {
    const status = await getLatestOrganizerAppStatus(id);
    if (status !== "APPROVED") {
      return res
        .status(409)
        .json({ error: "No puedes verificar al usuario: su solicitud de organizador no está aprobada." });
    }
  }

  try {
    const updated = await prisma.user.update({
      where: { id },
      data: { isVerified: Boolean(isVerified) },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isVerified: true,
        canSell: true,
        isActive: true,
        deletedAt: true,
        createdAt: true, // 👈 añadido
        updatedAt: true,
      },
    });

    const latestMap = await getLatestOrganizerAppStatuses([id]);
    res.json({ ...updated, latestOrganizerAppStatus: latestMap.get(id) ?? null });
  } catch {
    res.status(404).json({ error: "Usuario no encontrado" });
  }
}

export async function adminSetUserCanSell(req: Request, res: Response) {
  const id = Number(req.params.id);
  const { canSell } = req.body as { canSell: boolean };

  // Impedir habilitar venta si no hay solicitud aprobada
  if (canSell === true) {
    const status = await getLatestOrganizerAppStatus(id);
    if (status !== "APPROVED") {
      return res
        .status(409)
        .json({ error: "No puedes habilitar venta: la solicitud de organizador no está aprobada." });
    }
  }

  try {
    const updated = await prisma.user.update({
      where: { id },
      data: { canSell: Boolean(canSell) },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isVerified: true,
        canSell: true,
        isActive: true,
        deletedAt: true,
        createdAt: true, // 👈 añadido
        updatedAt: true,
      },
    });

    const latestMap = await getLatestOrganizerAppStatuses([id]);
    res.json({ ...updated, latestOrganizerAppStatus: latestMap.get(id) ?? null });
  } catch {
    res.status(404).json({ error: "Usuario no encontrado" });
  }
}

/* ===========================
 *  NUEVAS ACCIONES ADMIN
 * ===========================*/

/**
 * Desactivar cuenta (no borra): isActive=false, y por seguridad apaga venta/verificación.
 */
export async function adminDeactivateUser(req: Request, res: Response) {
  const id = Number(req.params.id);
  const auth = (req as any).user as { id: number; role: string } | undefined;

  // Opcional: evita auto-desactivarse si eres el único superadmin, etc.
  if (auth?.id === id && auth?.role === "superadmin") {
    return res.status(400).json({ error: "No puedes desactivar tu propia cuenta de superadmin." });
  }

  try {
    const updated = await prisma.user.update({
      where: { id },
      data: { isActive: false, canSell: false, isVerified: false },
      select: {
        id: true, name: true, email: true, role: true,
        isVerified: true, canSell: true, isActive: true, deletedAt: true,
        createdAt: true, // 👈 añadido
        updatedAt: true,
      },
    });

    const latestMap = await getLatestOrganizerAppStatuses([id]);
    res.json({ ...updated, latestOrganizerAppStatus: latestMap.get(id) ?? null });
  } catch {
    res.status(404).json({ error: "Usuario no encontrado" });
  }
}

/**
 * Reactivar cuenta: isActive=true (no toca canSell/isVerified).
 */
export async function adminActivateUser(req: Request, res: Response) {
  const id = Number(req.params.id);

  try {
    const updated = await prisma.user.update({
      where: { id },
      data: { isActive: true },
      select: {
        id: true, name: true, email: true, role: true,
        isVerified: true, canSell: true, isActive: true, deletedAt: true,
        createdAt: true, // 👈 añadido
        updatedAt: true,
      },
    });

    const latestMap = await getLatestOrganizerAppStatuses([id]);
    res.json({ ...updated, latestOrganizerAppStatus: latestMap.get(id) ?? null });
  } catch {
    res.status(404).json({ error: "Usuario no encontrado" });
  }
}

/**
 * Preview de eliminación: devuelve conteos de datos relacionados.
 */
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
    counts: {
      eventsOwned,
      reservationsMade,
      organizerApplications,
    },
    hasData: eventsOwned + reservationsMade + organizerApplications > 0,
  });
}

/**
 * Soft delete + anonimización:
 * - isActive=false, deletedAt=now
 * - canSell=false, isVerified=false
 * - anonimiza name/email/documentUrl
 * - REJECT a solicitudes PENDING/APPROVED
 * - DESHABILITA (approved=false) todos los eventos del usuario
 */
export async function adminSoftDeleteUser(req: Request, res: Response) {
  const id = Number(req.params.id);
  const auth = (req as any).user as { id: number; role: string } | undefined;

  // Bloquear borrar superadmin (o a sí mismo) por seguridad
  const current = await prisma.user.findUnique({
    where: { id },
    select: { id: true, role: true },
  });
  if (!current) return res.status(404).json({ error: "Usuario no encontrado" });
  if (current.role === "superadmin") {
    return res.status(400).json({ error: "No puedes eliminar una cuenta de superadmin." });
  }
  if (auth?.id === id && auth?.role === "superadmin") {
    return res.status(400).json({ error: "No puedes eliminar tu propia cuenta de superadmin." });
  }

  const now = new Date();
  const anonymEmail = `${id}.${now.getTime()}+deleted@invalid.local`;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1) Anonimizar y desactivar usuario
      const user = await tx.user.update({
        where: { id },
        data: {
          isActive: false,
          deletedAt: now,
          canSell: false,
          isVerified: false,
          name: "Cuenta eliminada",
          email: anonymEmail, // satisface unique
          documentUrl: null,
        },
        select: {
          id: true, name: true, email: true, role: true,
          isVerified: true, canSell: true, isActive: true, deletedAt: true,
          createdAt: true, // 👈 añadido
          updatedAt: true,
        },
      });

      // 2) Marcar solicitudes PENDING/APPROVED como REJECTED
      await tx.organizerApplication.updateMany({
        where: { userId: id, status: { in: ["PENDING", "APPROVED"] } },
        data: { status: "REJECTED" },
      });

      // 3) Inhabilitar TODOS los eventos del usuario
      const eventsRes = await tx.event.updateMany({
        where: { organizerId: id },
        data: { approved: false },
      });

      return { user, eventsDisabled: eventsRes.count };
    });

    const latestMap = await getLatestOrganizerAppStatuses([id]);
    return res.json({
      message: "Cuenta eliminada (soft) y eventos inhabilitados",
      user: result.user,
      eventsDisabled: result.eventsDisabled,
      latestOrganizerAppStatus: latestMap.get(id) ?? null,
    });
  } catch (err) {
    console.error("Soft delete error:", err);
    return res.status(500).json({ error: "No se pudo eliminar la cuenta" });
  }
}






