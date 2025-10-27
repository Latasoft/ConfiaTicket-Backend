// src/routes/admin.config.routes.ts
import { Router } from 'express';
import { authenticateToken, requireSuperadmin } from '../middleware/authMiddleware';
import {
  listTicketLimits,
  updateTicketLimit,
  getPriceLimit,
  updatePriceLimit,
  listFieldLimits,
  updateFieldLimit,
  listSystemConfigs,
  updateSystemConfig,
} from '../controllers/admin.config.controller';

const router = Router();

router.get('/ticket-limits', authenticateToken, requireSuperadmin, listTicketLimits);
router.put('/ticket-limits/:eventType', authenticateToken, requireSuperadmin, updateTicketLimit);

router.get('/price-limit', authenticateToken, requireSuperadmin, getPriceLimit);
router.put('/price-limit', authenticateToken, requireSuperadmin, updatePriceLimit);

router.get('/field-limits', authenticateToken, requireSuperadmin, listFieldLimits);
router.put('/field-limits/:fieldName', authenticateToken, requireSuperadmin, updateFieldLimit);

router.get('/system-configs', authenticateToken, requireSuperadmin, listSystemConfigs);
router.put('/system-configs/:key', authenticateToken, requireSuperadmin, updateSystemConfig);

export default router;
