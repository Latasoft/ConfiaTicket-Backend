// src/routes/organizer.events.routes.ts
import { Router } from 'express';
import {
  listMyEvents,
  createMyEvent,
  getMyEvent,
  updateMyEvent,
  deleteMyEvent,
} from '../controllers/organizer.events.controller';
import { authenticateToken, requireVerifiedOrganizer } from '../middleware/authMiddleware';

const router = Router();

// Requiere login y ser organizer verificado (superadmin pasa también por tu middleware)
router.use(authenticateToken, requireVerifiedOrganizer);

router.get('/', listMyEvents);
router.post('/', createMyEvent);
router.get('/:id', getMyEvent);
router.put('/:id', updateMyEvent);
router.delete('/:id', deleteMyEvent);

export default router;
