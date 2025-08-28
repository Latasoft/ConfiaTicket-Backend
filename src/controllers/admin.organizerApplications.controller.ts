// src/controllers/admin.organizerApplications.controller.ts
import { Request, Response } from "express";
import prisma from "../prisma/client";

type AppStatus = "PENDING" | "APPROVED" | "REJECTED";

function toInt(v: unknown, def: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}
function toStr(v: unknown) {
  return String(v ?? "").trim();
}

/**
 * GET /api/admin/organizer-applications
 * Query: page, pageSize, q, status
 */
export async function adminListOrganizerApplications(req: Request, res: Response) {
  const page = toInt(req.query.page, 1);
  const pageSize = Math.min(50, Math.max(5, toInt(req.query.pageSize, 10)));
  const q = toStr(req.query.q);
  const status = toStr(req.query.status).toUpperCase() as AppStatus | "";

  const where: any = {
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { legalName: { contains: q, mode: "insensitive" } },
            { taxId: { contains: q, mode: "insensitive" } },
            // 👇 filtro relacional correcto
            { user: { is: { name: { contains: q, mode: "insensitive" } } } },
            { user: { is: { email: { contains: q, mode: "insensitive" } } } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.organizerApplication.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        userId: true,
        legalName: true,
        taxId: true,
        phone: true,
        notes: true,
        idCardImage: true,
        status: true,
        createdAt: true,
        updatedAt: true, // 👈 agregado
        user: {
          select: { id: true, name: true, email: true },
        },
      },
    }),
    prisma.organizerApplication.count({ where }),
  ]);

  res.json({
    items: items.map((a) => ({
      id: a.id,
      userId: a.userId,
      legalName: a.legalName,
      taxId: a.taxId,
      phone: a.phone ?? "",
      notes: a.notes ?? "",
      idCardImage: a.idCardImage,
      status: a.status as AppStatus,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt, // 👈 agregado
      user: a.user ? { id: a.user.id, name: a.user.name, email: a.user.email } : null,
    })),
    total,
    page,
    pageSize,
  });
}

/**
 * POST /api/admin/organizer-applications/:id/approve
 * - Marca la solicitud como APPROVED
 * - Actualiza al usuario a role=organizer, isVerified=true, canSell=true
 */
export async function adminApproveOrganizerApplication(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

  const app = await prisma.organizerApplication.findUnique({
    where: { id },
    select: { id: true, status: true, userId: true },
  });
  if (!app) return res.status(404).json({ error: "Solicitud no encontrada" });

  if (app.status === "APPROVED") {
    return res.status(200).json({ ok: true, message: "La solicitud ya estaba aprobada." });
  }

  const [updatedApp, updatedUser] = await prisma.$transaction([
    prisma.organizerApplication.update({
      where: { id },
      data: { status: "APPROVED" },
      select: { id: true, status: true, updatedAt: true },
    }),
    prisma.user.update({
      where: { id: app.userId },
      data: {
        role: "organizer",
        isVerified: true,
        canSell: true,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isVerified: true,
        canSell: true,
      },
    }),
  ]);

  res.json({
    ok: true,
    message: "Solicitud aprobada",
    application: updatedApp,
    user: updatedUser,
  });
}

/**
 * POST /api/admin/organizer-applications/:id/reject
 * body: { notes?: string }
 * - Marca la solicitud como REJECTED
 * - Deshabilita verificación/venta del usuario
 */
export async function adminRejectOrganizerApplication(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

  const notes = toStr((req.body as any)?.notes);

  const app = await prisma.organizerApplication.findUnique({
    where: { id },
    select: { id: true, status: true, userId: true },
  });
  if (!app) return res.status(404).json({ error: "Solicitud no encontrada" });

  if (app.status === "REJECTED") {
    return res.status(200).json({ ok: true, message: "La solicitud ya estaba rechazada." });
  }

  const [updatedApp, updatedUser] = await prisma.$transaction([
    prisma.organizerApplication.update({
      where: { id },
      data: { status: "REJECTED", notes: notes || undefined },
      select: { id: true, status: true, notes: true, updatedAt: true },
    }),
    prisma.user.update({
      where: { id: app.userId },
      data: {
        isVerified: false,
        canSell: false,
        // role: "buyer", // <- Descomenta si quieres forzar volver a buyer
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isVerified: true,
        canSell: true,
      },
    }),
  ]);

  res.json({
    ok: true,
    message: "Solicitud rechazada",
    application: updatedApp,
    user: updatedUser,
  });
}

/**
 * POST /api/admin/organizer-applications/:id/reopen
 * - Vuelve la solicitud a PENDING
 * - Deshabilita verificación/venta del usuario mientras se reconsidera
 */
export async function adminReopenOrganizerApplication(req: Request, res: Response) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

  const app = await prisma.organizerApplication.findUnique({
    where: { id },
    select: { id: true, status: true, userId: true },
  });
  if (!app) return res.status(404).json({ error: "Solicitud no encontrada" });

  if (app.status === "PENDING") {
    return res.status(200).json({ ok: true, message: "La solicitud ya estaba en estado PENDING." });
  }

  const [updatedApp, updatedUser] = await prisma.$transaction([
    prisma.organizerApplication.update({
      where: { id },
      data: { status: "PENDING" },
      select: { id: true, status: true, updatedAt: true },
    }),
    prisma.user.update({
      where: { id: app.userId },
      data: {
        isVerified: false,
        canSell: false,
        // role: "buyer", // <- opcional: si quieres revertir el rol mientras está pendiente
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isVerified: true,
        canSell: true,
      },
    }),
  ]);

  res.json({
    ok: true,
    message: "Solicitud reabierta a PENDING",
    application: updatedApp,
    user: updatedUser,
  });
}



