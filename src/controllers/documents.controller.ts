// src/controllers/documents.controller.ts
import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { Prisma } from '@prisma/client';
import prisma from '../prisma/client';
import { env } from '../config/env';

interface Authed {
  id: number;
  role: 'buyer' | 'organizer' | 'superadmin';
}

/**
 * GET /api/documents/:type/:filename
 * Servir documentos con control de acceso
 * type: 'identity' (cédulas) o 'claims' (evidencia)
 */
export async function serveDocument(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const { type, filename } = req.params;

  // Validar tipo de documento
  if (type !== 'identity' && type !== 'claims') {
    return res.status(400).json({ error: 'Tipo de documento inválido' });
  }

  // Validar que filename existe
  if (!filename) {
    return res.status(400).json({ error: 'Nombre de archivo requerido' });
  }

  // Validar que el filename no contenga caracteres peligrosos (path traversal)
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Nombre de archivo inválido' });
  }

  // Construir ruta del archivo según el tipo
  const uploadsRoot = env.UPLOAD_DIR
    ? path.resolve(env.UPLOAD_DIR)
    : path.join(process.cwd(), 'uploads');
  
  const folderName = type === 'identity' ? 'documents' : 'claims';
  const filePath = path.join(uploadsRoot, folderName, filename);

  // Verificar que el archivo existe
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Archivo no encontrado' });
  }

  // Si es superadmin, permitir acceso directo a todo
  if (user.role === 'superadmin') {
    return res.sendFile(filePath);
  }

  // Control de acceso según el tipo de documento
  if (type === 'identity') {
    // Verificar si el archivo pertenece a la solicitud de organizador del usuario
    const organizerApplication = await prisma.organizerApplication.findFirst({
      where: {
        userId: user.id,
        OR: [
          { idCardImage: { contains: filename } },
          { idCardImageBack: { contains: filename } },
        ],
      },
    });

    if (!organizerApplication) {
      return res.status(403).json({ error: 'No tienes permiso para acceder a este documento de identidad' });
    }
  } else if (type === 'claims') {
    // Verificar si el archivo pertenece a un reclamo del usuario
    const claimMessages = await prisma.claimMessage.findMany({
      where: {
        attachments: {
          not: Prisma.JsonNull,
        },
      },
      include: {
        claim: {
          select: {
            buyerId: true,
          },
        },
      },
    });

    // Filtrar mensajes que contengan el archivo buscado
    const relevantMessages = claimMessages.filter((msg: any) => {
      if (!msg.attachments) return false;
      const attachments = msg.attachments as string[];
      // Buscar el filename en las URLs de attachments
      // Las URLs pueden ser: "/api/documents/claims/filename.jpg" o solo "filename.jpg"
      return attachments.some((url: string) => {
        if (!url) return false;
        // Extraer el filename de la URL
        const urlFilename = url.split('/').pop() || '';
        return urlFilename === filename;
      });
    });

    // Verificar si alguno de los mensajes pertenece a un reclamo del usuario
    const hasAccess = relevantMessages.some((msg: any) => msg.claim.buyerId === user.id);

    if (!hasAccess) {
      return res.status(403).json({ error: 'No tienes permiso para acceder a esta evidencia' });
    }
  }

  // Enviar el archivo
  res.sendFile(filePath);
}
