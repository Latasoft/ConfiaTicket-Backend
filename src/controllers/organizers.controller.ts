import { Request, Response } from 'express';
import prisma from '../prisma/client';
import path from 'path';
import fs from 'fs';

// Tipo local para evitar depender de @types/multer
type UploadedFile = {
  path: string;
  originalname: string;
  mimetype: string;
  filename?: string;
  size?: number;
};

/**
 * Listar todos los organizadores
 */
export async function listOrganizers(req: Request, res: Response) {
  try {
    const organizers = await prisma.user.findMany({
      where: { role: 'organizer' },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        canSell: true,
        isVerified: true,
        documentUrl: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(organizers);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error obteniendo organizadores' });
  }
}

/**
 * Cambiar estado de permiso de venta de un organizador (activar/desactivar)
 */
export async function toggleOrganizerPermission(req: Request, res: Response) {
  try {
    const organizerId = Number(req.params.id);
    const { canSell } = req.body as { canSell?: boolean };

    if (Number.isNaN(organizerId)) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    if (typeof canSell !== 'boolean') {
      return res.status(400).json({ error: 'Campo canSell debe ser booleano' });
    }

    const organizer = await prisma.user.update({
      where: { id: organizerId },
      data: { canSell },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        canSell: true,
        isVerified: true,
        updatedAt: true,
      },
    });

    res.json(organizer);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error actualizando permiso del organizador' });
  }
}

/**
 * Subir documento de identidad (organizador)
 * Requiere: middleware de multer -> upload.single('document')
 */
export async function uploadDocument(req: Request, res: Response) {
  try {
    const authUser = (req as any).user as { id?: number | string; role?: string } | undefined;
    if (!authUser?.id) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    const userId = Number(authUser.id);
    if (Number.isNaN(userId)) {
      return res.status(400).json({ error: 'Usuario inválido' });
    }

    const file = (req as any).file as UploadedFile | undefined;
    if (!file) {
      return res.status(400).json({ error: 'Archivo requerido (campo: document)' });
    }

    // Normaliza path (Windows -> /)
    const normalizedPath = (file.path || '').replace(/\\/g, '/');

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        documentUrl: normalizedPath,
        isVerified: false, // si re-sube documento, vuelve a pendiente
      },
      select: { id: true, documentUrl: true, isVerified: true, updatedAt: true },
    });

    res.json({ message: 'Documento subido, pendiente de verificación', user: updatedUser });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error subiendo documento' });
  }
}

/**
 * Listar organizadores pendientes por verificar (solo superadmin)
 */
export async function listPendingVerification(_req: Request, res: Response) {
  try {
    const pending = await prisma.user.findMany({
      where: { role: 'organizer', isVerified: false },
      select: {
        id: true,
        name: true,
        email: true,
        documentUrl: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(pending);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error listando organizadores pendientes' });
  }
}

/**
 * Aprobar o rechazar organizador (solo superadmin)
 * Body: { isVerified: boolean }
 */
export async function verifyOrganizer(req: Request, res: Response) {
  try {
    const organizerId = Number(req.params.id);
    const { isVerified } = req.body as { isVerified?: boolean };

    if (Number.isNaN(organizerId)) {
      return res.status(400).json({ error: 'ID inválido' });
    }
    if (typeof isVerified !== 'boolean') {
      return res.status(400).json({ error: 'Campo isVerified debe ser booleano' });
    }

    const target = await prisma.user.findUnique({ where: { id: organizerId } });
    if (!target || target.role !== 'organizer') {
      return res.status(404).json({ error: 'Organizador no encontrado' });
    }

    const updated = await prisma.user.update({
      where: { id: organizerId },
      data: { isVerified },
      select: { id: true, name: true, email: true, isVerified: true, updatedAt: true },
    });

    res.json({ message: 'Estado de verificación actualizado', organizer: updated });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error actualizando verificación' });
  }
}

/**
 * Obtener/descargar documento del organizador (solo superadmin)
 * GET /organizers/:id/document
 */
export async function getOrganizerDocument(req: Request, res: Response) {
  try {
    const organizerId = Number(req.params.id);
    if (Number.isNaN(organizerId)) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const user = await prisma.user.findUnique({
      where: { id: organizerId },
      select: { id: true, role: true, documentUrl: true },
    });

    if (!user || user.role !== 'organizer') {
      return res.status(404).json({ error: 'Organizador no encontrado' });
    }
    if (!user.documentUrl) {
      return res.status(404).json({ error: 'Documento no encontrado' });
    }

    const absPath = path.isAbsolute(user.documentUrl)
      ? user.documentUrl
      : path.join(process.cwd(), user.documentUrl);

    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: 'Archivo no existe en el servidor' });
    }

    return res.sendFile(absPath);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error obteniendo documento' });
  }
}

/**
 * NUEVO: Buyer solicita ser Organizer con foto de carnet
 * Ruta: POST /organizers/apply (upload.single('idCardImage'))
 * - Requiere estar autenticado como buyer
 * - Guarda la imagen y deja la solicitud en "pending"
 * - Si existe la tabla OrganizerApplication, la usa; si no, actualiza el usuario
 */
export async function applyOrganizer(req: Request, res: Response) {
  try {
    const authUser = (req as any).user as { id?: number; role?: string } | undefined;
    if (!authUser?.id) return res.status(401).json({ error: 'No autenticado' });

    const userId = Number(authUser.id);
    if (Number.isNaN(userId)) return res.status(400).json({ error: 'Usuario inválido' });

    // Solo buyers pueden solicitar
    if (authUser.role !== 'buyer') {
      return res.status(403).json({ error: 'Solo compradores pueden solicitar ser organizador' });
    }

    const file = (req as any).file as UploadedFile | undefined;
    if (!file) {
      return res.status(400).json({ error: 'Archivo requerido (campo: idCardImage)' });
    }

    const { legalName, taxId, phone, notes } = req.body as {
      legalName?: string; taxId?: string; phone?: string; notes?: string;
    };
    if (!legalName || !taxId) {
      return res.status(400).json({ error: 'legalName y taxId son requeridos' });
    }

    const normalizedPath = (file.path || '').replace(/\\/g, '/');

    // Intentar usar una tabla de aplicaciones si existe.
    try {
      // Si tienes el modelo OrganizerApplication en Prisma, esto funcionará.
      const application = await (prisma as any).organizerApplication.upsert({
        where: { userId },
        update: { legalName, taxId, phone, notes, idCardImage: normalizedPath, status: 'pending' },
        create: { userId, legalName, taxId, phone, notes, idCardImage: normalizedPath, status: 'pending' },
      });

      // Asegura flags en el usuario (no cambia rol aún)
      await prisma.user.update({
        where: { id: userId },
        data: { isVerified: false, canSell: false },
        select: { id: true },
      });

      return res.status(201).json({ message: 'Solicitud enviada', application });
    } catch (_e) {
      // Fallback si NO existe la tabla OrganizerApplication:
      const user = await prisma.user.update({
        where: { id: userId },
        data: {
          // Guardamos al menos la foto y dejamos flags bloqueados
          documentUrl: normalizedPath,
          isVerified: false,
          canSell: false,
        },
        select: {
          id: true, name: true, email: true, role: true,
          isVerified: true, canSell: true, documentUrl: true,
        },
      });

      return res.status(201).json({
        message: 'Solicitud recibida (pendiente de revisión). Se recomienda crear tabla OrganizerApplication para más datos.',
        user,
      });
    }
  } catch (error) {
    console.error('applyOrganizer error:', error);
    return res.status(500).json({ error: 'Error al enviar la solicitud' });
  }
}





