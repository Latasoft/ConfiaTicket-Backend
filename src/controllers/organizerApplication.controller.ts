// src/controllers/organizerApplication.controller.ts
import { Request, Response } from 'express';
import prisma from '../prisma/client';
import path from 'path';
import fs from 'fs';

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

    const { 
      legalName, 
      phone, 
      notes,
      payoutBankName,
      payoutAccountType,
      payoutAccountNumber,
    } = req.body;

    // Validaciones básicas
    if (!legalName || !legalName.trim()) {
      return res.status(400).json({ error: 'El nombre legal es requerido' });
    }

    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: 'El teléfono es requerido' });
    }

    // Validar datos bancarios obligatorios
    if (!payoutBankName || !payoutAccountType || !payoutAccountNumber) {
      return res.status(400).json({ error: 'Todos los datos bancarios son obligatorios' });
    }

    const file = (req as any).file as UploadedFile | undefined;
    if (!file) {
      return res.status(400).json({ error: 'Archivo requerido (idCardImage)' });
    }

    // Obtener el usuario para usar su RUT
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { rut: true },
    });

    if (!user || !user.rut) {
      return res.status(400).json({ error: 'Usuario no tiene RUT registrado. Por favor, actualiza tu perfil con tu RUT.' });
    }

    // extraer solo el nombre del archivo
    const filename = path.basename(file.path);

    // Evitar que un usuario envíe más de una solicitud si tiene una PENDIENTE o APROBADA
    const existing = await prisma.organizerApplication.findUnique({
      where: { userId: authUser.id },
      select: {
        status: true,
        idCardImage: true, // Necesitamos el nombre del archivo anterior
      },
    });

    if (existing) {
      if (existing.status === 'PENDING') {
        return res.status(400).json({ error: 'Ya tienes una solicitud pendiente de revisión' });
      }
      if (existing.status === 'APPROVED') {
        return res.status(400).json({ error: 'Tu solicitud ya fue aprobada' });
      }
      // Si status === 'REJECTED', permitimos actualizar la solicitud existente
    }

    // Usar el RUT del usuario para taxId y payoutHolderRut
    // Usar legalName también para payoutHolderName
    
    // Si existe una solicitud rechazada, actualizarla; si no, crear una nueva
    const application = existing && existing.status === 'REJECTED'
      ? await prisma.organizerApplication.update({
          where: { userId: authUser.id },
          data: {
            legalName: legalName.trim(),
            taxId: user.rut,
            phone: phone.trim(),
            notes: notes?.trim() || null,
            idCardImage: filename,
            payoutBankName,
            payoutAccountType,
            payoutAccountNumber,
            payoutHolderName: legalName.trim(),
            payoutHolderRut: user.rut,
            status: 'PENDING',
          },
        }).then(async (app) => {
          // Eliminar el archivo anterior si existe y es diferente del nuevo
          if (existing.idCardImage && existing.idCardImage !== filename) {
            const oldFilePath = path.join(process.cwd(), 'uploads', 'documents', existing.idCardImage);
            try {
              if (fs.existsSync(oldFilePath)) {
                fs.unlinkSync(oldFilePath);
                console.log(`Archivo anterior eliminado: ${existing.idCardImage}`);
              }
            } catch (err) {
              console.error(`Error eliminando archivo anterior: ${existing.idCardImage}`, err);
              // No falla la operación por esto
            }
          }
          return app;
        })
      : await prisma.organizerApplication.create({
          data: {
            userId: authUser.id,
            legalName: legalName.trim(),
            taxId: user.rut,
            phone: phone.trim(),
            notes: notes?.trim() || null,
            idCardImage: filename,
            payoutBankName,
            payoutAccountType,
            payoutAccountNumber,
            payoutHolderName: legalName.trim(),
            payoutHolderRut: user.rut,
            status: 'PENDING',
          },
        });

    res.status(201).json({ message: 'Solicitud enviada', application });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error enviando solicitud' });
  }
}

/**
 * GET /api/organizer-applications/my-application
 * Obtiene la solicitud de organizador del usuario autenticado
 */
export async function getMyApplication(req: Request, res: Response) {
  try {
    const authUser = (req as any).user as { id: number; role: string } | undefined;
    if (!authUser) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    const application = await prisma.organizerApplication.findUnique({
      where: { userId: authUser.id },
      select: {
        id: true,
        legalName: true,
        phone: true,
        notes: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        payoutBankName: true,
        payoutAccountType: true,
        payoutAccountNumber: true,
        payoutHolderName: true,
        payoutHolderRut: true,
      },
    });

    if (!application) {
      return res.status(404).json({ error: 'No tienes una solicitud' });
    }

    res.json(application);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error obteniendo solicitud' });
  }
}
