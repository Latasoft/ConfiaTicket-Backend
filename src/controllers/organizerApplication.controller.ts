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

    // DEBUG: Log de archivos recibidos
    console.log('=== DEBUG ORGANIZER APPLICATION ===');
    console.log('req.files:', (req as any).files);
    console.log('req.file:', (req as any).file);
    console.log('req.body:', req.body);

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

        // Manejar archivos múltiples (idCardImage frontal y idCardImageBack trasera - AMBAS OBLIGATORIAS)
    const files = (req as any).files as { [fieldname: string]: UploadedFile[] } | undefined;
    
    if (!files || !files.idCardImage || files.idCardImage.length === 0) {
      return res.status(400).json({ error: 'La imagen frontal de la cédula es requerida (idCardImage)' });
    }

    if (!files.idCardImageBack || files.idCardImageBack.length === 0) {
      return res.status(400).json({ error: 'La imagen trasera de la cédula es requerida (idCardImageBack)' });
    }

    const frontFile = files.idCardImage[0];
    const backFile = files.idCardImageBack[0];

    if (!frontFile) {
      return res.status(400).json({ error: 'Error procesando la imagen frontal de la cédula' });
    }

    if (!backFile) {
      return res.status(400).json({ error: 'Error procesando la imagen trasera de la cédula' });
    }

    // Obtener el usuario para usar su RUT
    const user = await prisma.user.findUnique({
      where: { id: authUser.id },
      select: { rut: true },
    });

    if (!user || !user.rut) {
      return res.status(400).json({ error: 'Usuario no tiene RUT registrado. Por favor, actualiza tu perfil con tu RUT.' });
    }

    // extraer solo el nombre de los archivos
    const frontFilename = path.basename(frontFile.path);
    const backFilename = path.basename(backFile.path);

    // Evitar que un usuario envíe más de una solicitud si tiene una PENDIENTE o APROBADA
    const existing = await prisma.organizerApplication.findUnique({
      where: { userId: authUser.id },
      select: {
        status: true,
        idCardImage: true, // Necesitamos el nombre del archivo anterior
        idCardImageBack: true,
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
            idCardImage: frontFilename,
            idCardImageBack: backFilename,
            payoutBankName,
            payoutAccountType,
            payoutAccountNumber,
            payoutHolderName: legalName.trim(),
            payoutHolderRut: user.rut,
            status: 'PENDING',
          },
        }).then(async (app) => {
          // Eliminar los archivos anteriores si existen y son diferentes de los nuevos
          if (existing.idCardImage && existing.idCardImage !== frontFilename) {
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
          if (existing.idCardImageBack && existing.idCardImageBack !== backFilename) {
            const oldFilePath = path.join(process.cwd(), 'uploads', 'documents', existing.idCardImageBack);
            try {
              if (fs.existsSync(oldFilePath)) {
                fs.unlinkSync(oldFilePath);
                console.log(`Archivo anterior eliminado: ${existing.idCardImageBack}`);
              }
            } catch (err) {
              console.error(`Error eliminando archivo anterior: ${existing.idCardImageBack}`, err);
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
            idCardImage: frontFilename,
            idCardImageBack: backFilename,
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
