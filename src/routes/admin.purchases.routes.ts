// src/routes/admin.purchases.routes.ts
import { Router } from 'express';
import { authenticateToken, requireSuperadmin } from '../middleware/authMiddleware';
import {
  adminListPurchases,
  adminGetPurchaseDetail,
} from '../controllers/admin.purchases.controller';

const router = Router();

// Todas las rutas requieren autenticación y rol superadmin
router.use(authenticateToken, requireSuperadmin);

// GET /api/admin/purchases - Lista de compras con filtros
router.get('/', adminListPurchases);

// GET /api/admin/purchases/:id - Detalle de una compra
router.get('/:id', adminGetPurchaseDetail);

export default router;
