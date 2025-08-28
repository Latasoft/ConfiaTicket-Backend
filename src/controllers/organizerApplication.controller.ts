// src/controllers/organizerApplication.controller.ts
import { Request, Response } from 'express';
import prisma from '../prisma/client';
import path from 'path';

type UploadedFile = {
  path: string;
  originalname: string;
  mimetype: string;
};

export async function applyOrganizer(req: Request, res: Response) {
  try {
    const authUser = (req as any).user as { id: number; role: string } | undefined;
    if (!authUser) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    const { legalName, taxId, phone, notes } = req.body;

    if (!legalName || !taxId) {
      return res.status(400).json({ error: 'Faltan datos requeridos' });
    }

    const file = (req as any).file as UploadedFile | undefined;
    if (!file) {
      return res.status(400).json({ error: 'Archivo requerido (idCardImage)' });
    }

    const normalizedPath = file.path.replace(/\\/g, '/');

    // Evitar que un usuario envíe más de una solicitud
    const existing = await prisma.organizerApplication.findUnique({
      where: { userId: authUser.id },
    });

    if (existing) {
      return res.status(400).json({ error: 'Ya enviaste una solicitud' });
    }

    const application = await prisma.organizerApplication.create({
      data: {
        userId: authUser.id,
        legalName,
        taxId,
        phone,
        notes,
        idCardImage: normalizedPath,
      },
    });

    res.status(201).json({ message: 'Solicitud enviada', application });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error enviando solicitud' });
  }
}
