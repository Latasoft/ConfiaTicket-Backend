import { Router } from 'express';
import { authenticateToken, authorizeRoles } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload.middleware';
import { applyOrganizer, getMyApplication } from '../controllers/organizerApplication.controller';

const router = Router();

// Obtener mi solicitud
router.get(
  '/my-application',
  authenticateToken,
  getMyApplication
);

// Buyer solicita ser organizador con foto de carnet (campo: idCardImage)
router.post(
  '/apply',
  authenticateToken,
  authorizeRoles('buyer'),
  upload.single('idCardImage'),
  applyOrganizer
);

export default router;
