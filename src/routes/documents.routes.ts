// src/routes/documents.routes.ts
import { Router } from 'express';
import { authenticateToken } from '../middleware/authMiddleware';
import { serveDocument } from '../controllers/documents.controller';

const router = Router();

/**
 * GET /api/documents/:type/:filename
 * Servir documento con control de acceso
 * type: 'identity' (cédulas) o 'claims' (evidencia)
 */
router.get(
  '/:type/:filename',
  authenticateToken,
  serveDocument
);

export default router;
