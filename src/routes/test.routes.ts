// src/routes/test.routes.ts
import { Router } from 'express';
import { authenticateToken } from '../middleware/authMiddleware';
import { testEmail, getSmtpConfig } from '../controllers/email.test.controller';

const router = Router();

// Endpoints de prueba (requieren autenticación)
router.post('/email', authenticateToken, testEmail);
router.get('/smtp-config', authenticateToken, getSmtpConfig);

export default router;
