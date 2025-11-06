// src/routes/admin.events.routes.ts
import { Router } from 'express';
import {
  adminListEvents,
  adminGetEvent,
  adminSetEventStatus,
  adminDeleteEvent,
} from '../controllers/admin.events.controller';
import { authenticateToken, authorizeRoles } from '../middleware/authMiddleware'; // 👈 aquí

const router = Router();

// Sólo superadmin
router.use(authenticateToken, authorizeRoles('superadmin'));

router.get('/', adminListEvents);
router.get('/:id', adminGetEvent);
router.patch('/:id/status', adminSetEventStatus);
router.delete('/:id', adminDeleteEvent);

export default router;

