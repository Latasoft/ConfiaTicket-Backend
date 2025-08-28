import { Router } from 'express';
import { authenticateToken, authorizeRoles } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload.middleware';
import { applyOrganizer } from '../controllers/organizerApplication.controller';

const router = Router();

router.post(
  '/apply',
  authenticateToken,
  authorizeRoles('buyer'), // solo compradores pueden solicitar
  upload.single('idCardImage'), // campo del formulario
  applyOrganizer
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
