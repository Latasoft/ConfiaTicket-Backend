// src/routes/admin.documents.routes.ts
import { Router } from 'express';
import { authenticateToken, authorizeRoles } from '../middleware/authMiddleware';
import { getDocument } from '../controllers/admin.documents.controller';

const router = Router();

/**
 * GET /api/admin/documents/*
 * Para acceder a documentos protegidos (como idCardImage) solo como superadmin
 */
router.use(
  authenticateToken,
  authorizeRoles('superadmin'),
  getDocument
);

export default router;
