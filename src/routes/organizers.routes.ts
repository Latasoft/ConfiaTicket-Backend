import { Router } from 'express';
import {
  listOrganizers,
  toggleOrganizerPermission,
  uploadDocument,
  listPendingVerification,
  verifyOrganizer,
  getOrganizerDocument,
  applyOrganizer, // <-- NUEVO
} from '../controllers/organizers.controller';
import { authenticateToken, authorizeRoles } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload.middleware';

const router = Router();

// --- NUEVO: Buyer solicita ser Organizer con foto de carnet ---
// Campo de archivo: idCardImage (JPG/PNG, validado en middleware)
router.post(
  '/apply',
  authenticateToken,
  authorizeRoles('buyer'),
  upload.single('idCardImage'),
  applyOrganizer
);

// Solo superadmin puede listar organizadores
router.get(
  '/',
  authenticateToken,
  authorizeRoles('superadmin'),
  listOrganizers
);

// Solo superadmin puede activar/desactivar permiso de venta
router.patch(
  '/:id/permission',
  authenticateToken,
  authorizeRoles('superadmin'),
  toggleOrganizerPermission
);

// Organizador sube su documento
router.post(
  '/upload-document',
  authenticateToken,
  authorizeRoles('organizer'),
  upload.single('document'),
  uploadDocument
);

// Listar organizadores pendientes (solo superadmin)
router.get(
  '/pending-verification',
  authenticateToken,
  authorizeRoles('superadmin'),
  listPendingVerification
);

// Aprobar o rechazar organizador (solo superadmin)
// Body: { isVerified: boolean }
router.patch(
  '/:id/verify',
  authenticateToken,
  authorizeRoles('superadmin'),
  verifyOrganizer
);

// Ver/descargar documento del organizador (solo superadmin)
router.get(
  '/:id/document',
  authenticateToken,
  authorizeRoles('superadmin'),
  getOrganizerDocument
);

export default router;



