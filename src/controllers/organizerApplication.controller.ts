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

    // Evitar que un usuario envíe más de una solicitud
    const existing = await prisma.organizerApplication.findUnique({
      where: { userId: authUser.id },
    });

    if (existing) {
      return res.status(400).json({ error: 'Ya enviaste una solicitud' });
    }

    // Usar el RUT del usuario para taxId y payoutHolderRut
    // Usar legalName también para payoutHolderName
    const application = await prisma.organizerApplication.create({
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
        payoutHolderName: legalName.trim(), // Mismo que legalName
        payoutHolderRut: user.rut, // Mismo que el RUT del usuario
      },
    });

    res.status(201).json({ message: 'Solicitud enviada', application });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error enviando solicitud' });
  }
}
