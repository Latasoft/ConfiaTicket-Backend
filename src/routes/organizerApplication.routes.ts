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

// Buyer solicita ser organizador con foto de carnet (campos: idCardImage, idCardImageBack)
router.post(
  '/apply',
  authenticateToken,
  authorizeRoles('buyer'),
  upload.fields([
    { name: 'idCardImage', maxCount: 1 },
    { name: 'idCardImageBack', maxCount: 1 }
  ]),
  applyOrganizer
);

export default router;
