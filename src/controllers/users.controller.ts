// src/controllers/users.controller.ts
import { Request, Response } from 'express';
import prisma from '../prisma/client';

// Listar todos los usuarios (solo superadmin)
export async function listUsers(req: Request, res: Response) {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
}

// Obtener detalles de un usuario por id (solo superadmin)
export async function getUserDetails(req: Request, res: Response) {
  try {
    const userId = Number(req.params.id);
    if (isNaN(userId)) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json(user);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener detalles del usuario' });
  }
}

// Actualizar rol de usuario (solo superadmin)
export async function updateUserRole(req: Request, res: Response) {
  try {
    const userId = Number(req.params.id);
    const { role } = req.body;

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const validRoles = ['superadmin', 'organizer', 'buyer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Rol inválido' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { role },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
    });

    res.json(updatedUser);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error actualizando rol de usuario' });
  }
}

// Eliminar usuario (solo superadmin)
export async function deleteUser(req: Request, res: Response) {
  try {
    const userId = Number(req.params.id);

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'ID inválido' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    await prisma.user.delete({ where: { id: userId } });

    res.json({ message: 'Usuario eliminado correctamente' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error eliminando usuario' });
  }
}
