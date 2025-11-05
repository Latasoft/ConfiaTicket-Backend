// src/controllers/claims.controller.ts
import { Request, Response } from 'express';
import prisma from '../prisma/client';
import { Prisma } from '@prisma/client';
import { 
  sendClaimCreatedEmail, 
  sendClaimStatusUpdateEmail 
} from '../services/email.service';

type Authed = { id: number; role: string };

/**
 * POST /api/claims
 * Crear un nuevo reclamo (solo compradores)
 */
export async function createClaim(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  
  const {
    reservationId,
    reason,
    description,
    attachmentUrl,
  } = req.body as {
    reservationId: number;
    reason: string;
    description: string;
    attachmentUrl?: string;
  };

  // Validaciones básicas
  if (!reservationId) {
    return res.status(400).json({ error: 'El ID de la reserva es requerido' });
  }

  if (!reason) {
    return res.status(400).json({ error: 'El motivo del reclamo es requerido' });
  }

  if (!description || description.trim().length === 0) {
    return res.status(400).json({ error: 'La descripción del reclamo es requerida' });
  }

  if (description.length > 2000) {
    return res.status(400).json({ error: 'La descripción no puede exceder 2000 caracteres' });
  }

  // Validar que la reserva existe y pertenece al usuario
  const reservation = await prisma.reservation.findFirst({
    where: {
      id: reservationId,
      buyerId: user.id,
    },
    include: {
      event: true,
    },
  });

  if (!reservation) {
    return res.status(404).json({ error: 'Reserva no encontrada' });
  }

  // Validar que la reserva esté pagada
  if (reservation.status !== 'PAID') {
    return res.status(400).json({ 
      error: 'Solo puedes crear reclamos para reservas pagadas' 
    });
  }

  // Verificar que no exista ya un reclamo para esta reserva
  const existingClaim = await prisma.claim.findUnique({
    where: { reservationId },
  });

  if (existingClaim) {
    return res.status(400).json({ 
      error: 'Ya existe un reclamo para esta reserva',
      claimId: existingClaim.id,
    });
  }

  const hoursLimit = 48;
  const eventDate = reservation.event.date;
  const currentTime = new Date();
  
  // No permitir reclamos ANTES del evento
  if (currentTime < eventDate) {
    return res.status(400).json({ 
      error: 'No puedes crear un reclamo antes de que ocurra el evento',
      eventDate: eventDate,
    });
  }
  
  const hoursSinceEvent = (currentTime.getTime() - eventDate.getTime()) / (1000 * 60 * 60);
  
  if (hoursSinceEvent > hoursLimit) {
    const deadlineDate = new Date(eventDate.getTime() + hoursLimit * 60 * 60 * 1000);
    return res.status(400).json({ 
      error: `El plazo para crear un reclamo ha expirado. Solo puedes reclamar dentro de las ${hoursLimit} horas posteriores al evento.`,
      eventDate: eventDate,
      deadline: deadlineDate,
      hoursLimit: hoursLimit,
    });
  }

  // Determinar prioridad según el motivo
  let priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' = 'MEDIUM';
  
  if (reason === 'TICKET_INVALID' || reason === 'TICKET_DUPLICATED') {
    priority = 'HIGH';
  } else if (reason === 'TICKET_NOT_RECEIVED') {
    priority = 'HIGH';
  } else if (reason === 'EVENT_CANCELLED') {
    priority = 'URGENT';
  } else if (reason === 'OTHER' || reason === 'POOR_QUALITY') {
    priority = 'LOW';
  }

  // Crear el reclamo
  const claim = await prisma.claim.create({
    data: {
      buyerId: user.id,
      reservationId,
      eventId: reservation.eventId,
      reason: reason as any, // Conversión necesaria para el enum de Prisma
      description: description.trim(),
      attachmentUrl,
      priority: priority as any,
      status: 'PENDING' as any,
    },
    include: {
      reservation: {
        include: {
          event: true,
        },
      },
      buyer: {
        select: { name: true, email: true },
      },
    },
  });

  // Enviar email de confirmación
  try {
    await sendClaimCreatedEmail({
      buyerEmail: claim.buyer.email,
      buyerName: claim.buyer.name,
      claimId: claim.id,
      eventTitle: claim.reservation.event.title,
      reason: claim.reason,
    });
  } catch (emailError: any) {
    console.error('❌ Error enviando email de reclamo:', emailError.message);
    // No fallar si el email falla
  }

  res.status(201).json(claim);
}

/**
 * GET /api/claims
 * Listar los reclamos del usuario autenticado
 */
export async function listMyClaims(req: Request, res: Response) {
  const user = (req as any).user as Authed;

  const claims = await prisma.claim.findMany({
    where: { buyerId: user.id },
    include: {
      reservation: {
        include: {
          event: {
            select: {
              id: true,
              title: true,
              date: true,
              location: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json(claims);
}

/**
 * GET /api/claims/:id
 * Obtener detalle de un reclamo específico
 */
export async function getClaim(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const claimId = Number(req.params.id);

  const claim = await prisma.claim.findFirst({
    where: {
      id: claimId,
      buyerId: user.id,
    },
    include: {
      reservation: {
        include: {
          event: true,
        },
      },
    },
  });

  if (!claim) {
    return res.status(404).json({ error: 'Reclamo no encontrado' });
  }

  res.json(claim);
}

/**
 * PUT /api/claims/:id/cancel
 * Cancelar un reclamo (solo si está pendiente o esperando información)
 */
export async function cancelClaim(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const claimId = Number(req.params.id);

  const claim = await prisma.claim.findFirst({
    where: {
      id: claimId,
      buyerId: user.id,
    },
  });

  if (!claim) {
    return res.status(404).json({ error: 'Reclamo no encontrado' });
  }

  if (claim.status !== 'PENDING' && claim.status !== 'WAITING_INFO') {
    return res.status(400).json({ 
      error: 'Solo puedes cancelar reclamos que estén pendientes o esperando información' 
    });
  }

  const updated = await prisma.claim.update({
    where: { id: claimId },
    data: {
      status: 'CANCELLED',
      canReopen: true, // Los reclamos cancelados se pueden reabrir sin límite
    },
  });

  res.json(updated);
}

/**
 * PUT /api/claims/:id/reopen
 * Reabrir un reclamo cancelado o rechazado
 */
export async function reopenClaim(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const claimId = Number(req.params.id);

  const { additionalInfo } = req.body as { additionalInfo?: string };

  const claim = await prisma.claim.findFirst({
    where: {
      id: claimId,
      buyerId: user.id,
    },
  });

  if (!claim) {
    return res.status(404).json({ error: 'Reclamo no encontrado' });
  }

  if (!claim.canReopen) {
    return res.status(400).json({ 
      error: 'Este reclamo no puede ser reabierto. Has alcanzado el límite de reaperturas.' 
    });
  }

  // Validar lógica de reaperturas según el estado
  if (claim.status === 'REJECTED') {
    // Rechazados: solo 1 reapertura
    if (claim.reopenCount >= 1) {
      return res.status(400).json({ 
        error: 'Los reclamos rechazados solo pueden reabrirse una vez' 
      });
    }
  } else if (claim.status === 'RESOLVED') {
    // Resueltos: solo 1 apelación
    if (claim.reopenCount >= 1) {
      return res.status(400).json({ 
        error: 'Los reclamos resueltos solo pueden apelarse una vez' 
      });
    }
  } else if (claim.status !== 'CANCELLED') {
    // Solo se pueden reabrir: CANCELLED, REJECTED, RESOLVED
    return res.status(400).json({ 
      error: 'Solo puedes reabrir reclamos cancelados, rechazados o resueltos' 
    });
  }

  // Actualizar descripción si se proporciona info adicional
  let newDescription = claim.description;
  if (additionalInfo && additionalInfo.trim().length > 0) {
    newDescription = `${claim.description}\n\n--- REAPERTURA ---\n${additionalInfo.trim()}`;
  }

  const updated = await prisma.claim.update({
    where: { id: claimId },
    data: {
      status: 'PENDING',
      reopenCount: claim.reopenCount + 1,
      reopenedAt: new Date(),
      description: newDescription,
      canReopen: claim.status === 'CANCELLED' ? true : claim.reopenCount + 1 < 1, // Cancelados ilimitado, otros 1 vez
    },
  });

  res.json(updated);
}

// ============ ADMIN ENDPOINTS ============

/**
 * GET /api/admin/claims
 * Listar todos los reclamos (admin)
 */
export async function adminListClaims(req: Request, res: Response) {
  const { status, priority, eventId } = req.query;

  const where: any = {};
  
  if (status) {
    where.status = status;
  }
  
  if (priority) {
    where.priority = priority;
  }
  
  if (eventId) {
    where.eventId = Number(eventId);
  }

  const claims = await prisma.claim.findMany({
    where,
    include: {
      buyer: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
      reservation: {
        include: {
          event: {
            select: {
              id: true,
              title: true,
              date: true,
              location: true,
            },
          },
        },
      },
    },
    orderBy: [
      { priority: 'desc' },
      { createdAt: 'asc' },
    ],
  });

  res.json(claims);
}

/**
 * GET /api/admin/claims/:id
 * Obtener detalle completo de un reclamo (admin)
 */
export async function adminGetClaim(req: Request, res: Response) {
  const claimId = Number(req.params.id);

  const claim = await prisma.claim.findUnique({
    where: { id: claimId },
    include: {
      buyer: {
        select: {
          id: true,
          name: true,
          email: true,
          rut: true,
        },
      },
      reservation: {
        include: {
          event: true,
          payment: true,
        },
      },
    },
  });

  if (!claim) {
    return res.status(404).json({ error: 'Reclamo no encontrado' });
  }

  res.json(claim);
}

/**
 * PUT /api/admin/claims/:id/status
 * Actualizar el estado de un reclamo (admin)
 */
export async function adminUpdateClaimStatus(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const claimId = Number(req.params.id);

  const {
    status,
    adminResponse,
    resolution,
  } = req.body as {
    status: string;
    adminResponse?: string;
    resolution?: string;
  };

  if (!status) {
    return res.status(400).json({ error: 'El estado es requerido' });
  }

  const validStatuses = ['PENDING', 'IN_REVIEW', 'WAITING_INFO', 'RESOLVED', 'REJECTED'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Estado inválido' });
  }

  const claim = await prisma.claim.findUnique({
    where: { id: claimId },
  });

  if (!claim) {
    return res.status(404).json({ error: 'Reclamo no encontrado' });
  }

  const data: any = {
    status,
    reviewedBy: user.id,
    reviewedAt: new Date(),
  };

  if (adminResponse) {
    data.adminResponse = adminResponse.trim();
  }

  if (status === 'RESOLVED' || status === 'REJECTED') {
    data.resolvedAt = new Date();
    
    if (resolution) {
      data.resolution = resolution.trim();
    }

    // Limitar reaperturas según el estado
    if (status === 'REJECTED' || status === 'RESOLVED') {
      data.canReopen = claim.reopenCount < 1; // Solo 1 reapertura
    }
  }

  const updated = await prisma.claim.update({
    where: { id: claimId },
    data,
    include: {
      buyer: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
      reservation: {
        include: {
          event: true,
        },
      },
    },
  });

  // Enviar email de notificación al comprador
  try {
    await sendClaimStatusUpdateEmail({
      buyerEmail: updated.buyer.email,
      buyerName: updated.buyer.name,
      claimId: updated.id,
      eventTitle: updated.reservation.event.title,
      newStatus: status,
      adminResponse: adminResponse || undefined,
    });
  } catch (emailError: any) {
    console.error('❌ Error enviando email de actualización:', emailError.message);
    // No fallar si el email falla
  }

  res.json(updated);
}

/**
 * PUT /api/admin/claims/:id/priority
 * Actualizar la prioridad de un reclamo (admin)
 */
export async function adminUpdateClaimPriority(req: Request, res: Response) {
  const claimId = Number(req.params.id);
  const { priority } = req.body as { priority: string };

  const validPriorities = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
  if (!priority || !validPriorities.includes(priority)) {
    return res.status(400).json({ error: 'Prioridad inválida' });
  }

  const updated = await prisma.claim.update({
    where: { id: claimId },
    data: { priority: priority as any },
  });

  res.json(updated);
}

// ============ MENSAJES Y EVIDENCIA ============

/**
 * GET /api/claims/:id/messages
 * Obtener todos los mensajes de un reclamo (comprador)
 */
export async function getClaimMessages(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const claimId = Number(req.params.id);

  // Verificar que el reclamo pertenece al usuario
  const claim = await prisma.claim.findFirst({
    where: { id: claimId, buyerId: user.id },
  });

  if (!claim) {
    return res.status(404).json({ error: 'Reclamo no encontrado' });
  }

  const messages = await prisma.claimMessage.findMany({
    where: { claimId },
    orderBy: { createdAt: 'asc' },
  });

  res.json(messages);
}

/**
 * POST /api/claims/:id/messages
 * Agregar mensaje o evidencia a un reclamo (comprador)
 */
export async function addClaimMessage(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const claimId = Number(req.params.id);

  const { message, attachments } = req.body as {
    message?: string;
    attachments?: string[];
  };

  // Validar que al menos haya mensaje o adjuntos
  if (!message?.trim() && (!attachments || attachments.length === 0)) {
    return res.status(400).json({ 
      error: 'Debes proporcionar un mensaje o adjuntar evidencia' 
    });
  }

  if (message && message.length > 2000) {
    return res.status(400).json({ 
      error: 'El mensaje no puede exceder 2000 caracteres' 
    });
  }

  // Verificar que el reclamo pertenece al usuario
  const claim = await prisma.claim.findFirst({
    where: { id: claimId, buyerId: user.id },
  });

  if (!claim) {
    return res.status(404).json({ error: 'Reclamo no encontrado' });
  }

  // Solo permitir agregar mensajes si el reclamo está en ciertos estados
  const allowedStatuses = ['PENDING', 'IN_REVIEW', 'WAITING_INFO'];
  if (!allowedStatuses.includes(claim.status)) {
    return res.status(400).json({ 
      error: 'No puedes agregar mensajes a un reclamo cerrado. Considera reabrirlo si es necesario.' 
    });
  }

  // Determinar el tipo de mensaje
  const type = attachments && attachments.length > 0 ? 'BUYER_EVIDENCE' : 'BUYER_MESSAGE';

  const newMessage = await prisma.claimMessage.create({
    data: {
      claimId,
      type: type as any,
      message: message?.trim() || null,
      attachments: attachments && attachments.length > 0 ? attachments : Prisma.JsonNull,
      authorId: user.id,
      authorRole: 'buyer',
    },
  });

  // Si el reclamo estaba esperando info, cambiar estado a IN_REVIEW
  if (claim.status === 'WAITING_INFO') {
    await prisma.claim.update({
      where: { id: claimId },
      data: { status: 'IN_REVIEW' },
    });
  }

  res.status(201).json(newMessage);
}

/**
 * GET /api/admin/claims/:id/messages
 * Obtener todos los mensajes de un reclamo (admin)
 */
export async function adminGetClaimMessages(req: Request, res: Response) {
  const claimId = Number(req.params.id);

  const messages = await prisma.claimMessage.findMany({
    where: { claimId },
    orderBy: { createdAt: 'asc' },
  });

  res.json(messages);
}

/**
 * POST /api/admin/claims/:id/messages
 * Agregar respuesta del admin
 */
export async function adminAddClaimMessage(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const claimId = Number(req.params.id);

  const { message } = req.body as { message: string };

  if (!message?.trim()) {
    return res.status(400).json({ error: 'El mensaje es requerido' });
  }

  if (message.length > 2000) {
    return res.status(400).json({ 
      error: 'El mensaje no puede exceder 2000 caracteres' 
    });
  }

  const claim = await prisma.claim.findUnique({
    where: { id: claimId },
  });

  if (!claim) {
    return res.status(404).json({ error: 'Reclamo no encontrado' });
  }

  const newMessage = await prisma.claimMessage.create({
    data: {
      claimId,
      type: 'ADMIN_RESPONSE',
      message: message.trim(),
      authorId: user.id,
      authorRole: 'superadmin',
    },
  });

  // Si el reclamo estaba pendiente, cambiar a IN_REVIEW
  if (claim.status === 'PENDING') {
    await prisma.claim.update({
      where: { id: claimId },
      data: { 
        status: 'IN_REVIEW',
        reviewedBy: user.id,
        reviewedAt: new Date(),
      },
    });
  }

  res.status(201).json(newMessage);
}

/**
 * POST /api/claims/:id/upload-evidence
 * Subir archivos de evidencia (comprador)
 */
export async function uploadClaimEvidence(req: Request, res: Response) {
  const user = (req as any).user as Authed;
  const claimId = Number(req.params.id);

  // Verificar que el reclamo pertenece al usuario
  const claim = await prisma.claim.findFirst({
    where: { id: claimId, buyerId: user.id },
  });

  if (!claim) {
    return res.status(404).json({ error: 'Reclamo no encontrado' });
  }

  // Solo permitir subir evidencia si el reclamo está en ciertos estados
  const allowedStatuses = ['PENDING', 'IN_REVIEW', 'WAITING_INFO'];
  if (!allowedStatuses.includes(claim.status)) {
    return res.status(400).json({ 
      error: 'No puedes agregar evidencia a un reclamo cerrado' 
    });
  }

  // Obtener archivos subidos
  const files = (req as any).files as Express.Multer.File[] | undefined;
  
  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'Debes subir al menos un archivo' });
  }

  // Construir URLs de los archivos
  const attachmentUrls = files.map((file) => {
    // Los archivos se accederán mediante endpoint protegido /api/documents/claims/:filename
    return `/api/documents/claims/${file.filename}`;
  });

  // Crear mensaje con evidencia
  const message = req.body.message?.trim() || null;
  
  const newMessage = await prisma.claimMessage.create({
    data: {
      claimId,
      type: 'BUYER_EVIDENCE',
      message,
      attachments: attachmentUrls,
      authorId: user.id,
      authorRole: 'buyer',
    },
  });

  // Si el reclamo estaba esperando info, cambiar estado a IN_REVIEW
  if (claim.status === 'WAITING_INFO') {
    await prisma.claim.update({
      where: { id: claimId },
      data: { status: 'IN_REVIEW' },
    });
  }

  res.status(201).json(newMessage);
}
