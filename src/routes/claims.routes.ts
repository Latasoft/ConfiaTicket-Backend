// src/routes/claims.routes.ts
import { Router } from 'express';
import {
  authenticateToken,
  authorizeRoles,
} from '../middleware/authMiddleware';
import { uploadClaims } from '../middleware/upload.middleware';
import {
  createClaim,
  listMyClaims,
  getClaim,
  cancelClaim,
  reopenClaim,
  getClaimMessages,
  addClaimMessage,
  uploadClaimEvidence,
  adminListClaims,
  adminGetClaim,
  adminUpdateClaimStatus,
  adminUpdateClaimPriority,
  adminGetClaimMessages,
  adminAddClaimMessage,
} from '../controllers/claims.controller';

const router = Router();

// =============== RUTAS DE USUARIOS (COMPRADORES) ===============

/**
 * POST /api/claims
 * Crear un nuevo reclamo
 */
router.post(
  '/',
  authenticateToken,
  createClaim
);

/**
 * GET /api/claims
 * Listar mis reclamos
 */
router.get(
  '/',
  authenticateToken,
  listMyClaims
);

/**
 * GET /api/claims/:id
 * Obtener detalle de un reclamo
 */
router.get(
  '/:id',
  authenticateToken,
  getClaim
);

/**
 * PUT /api/claims/:id/cancel
 * Cancelar un reclamo
 */
router.put(
  '/:id/cancel',
  authenticateToken,
  cancelClaim
);

/**
 * PUT /api/claims/:id/reopen
 * Reabrir un reclamo
 */
router.put(
  '/:id/reopen',
  authenticateToken,
  reopenClaim
);

/**
 * GET /api/claims/:id/messages
 * Obtener mensajes de un reclamo
 */
router.get(
  '/:id/messages',
  authenticateToken,
  getClaimMessages
);

/**
 * POST /api/claims/:id/messages
 * Agregar mensaje o evidencia
 */
router.post(
  '/:id/messages',
  authenticateToken,
  addClaimMessage
);

/**
 * POST /api/claims/:id/upload-evidence
 * Subir archivos de evidencia
 */
router.post(
  '/:id/upload-evidence',
  authenticateToken,
  uploadClaims.array('evidence', 5),
  uploadClaimEvidence
);

// =============== RUTAS DE ADMIN ===============

/**
 * GET /api/admin/claims
 * Listar todos los reclamos (admin)
 */
router.get(
  '/admin/all',
  authenticateToken,
  authorizeRoles('superadmin'),
  adminListClaims
);

/**
 * GET /api/admin/claims/:id
 * Obtener detalle completo de un reclamo (admin)
 */
router.get(
  '/admin/:id',
  authenticateToken,
  authorizeRoles('superadmin'),
  adminGetClaim
);

/**
 * PUT /api/admin/claims/:id/status
 * Actualizar estado de un reclamo (admin)
 */
router.put(
  '/admin/:id/status',
  authenticateToken,
  authorizeRoles('superadmin'),
  adminUpdateClaimStatus
);

/**
 * PUT /api/admin/claims/:id/priority
 * Actualizar prioridad de un reclamo (admin)
 */
router.put(
  '/admin/:id/priority',
  authenticateToken,
  authorizeRoles('superadmin'),
  adminUpdateClaimPriority
);

/**
 * GET /api/admin/claims/:id/messages
 * Obtener mensajes de un reclamo (admin)
 */
router.get(
  '/admin/:id/messages',
  authenticateToken,
  authorizeRoles('superadmin'),
  adminGetClaimMessages
);

/**
 * POST /api/admin/claims/:id/messages
 * Agregar respuesta del admin
 */
router.post(
  '/admin/:id/messages',
  authenticateToken,
  authorizeRoles('superadmin'),
  adminAddClaimMessage
);

export default router;
