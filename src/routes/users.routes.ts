// src/routes/users.routes.ts
import { Router } from 'express';
import { authenticateToken, authorizeRoles } from '../middleware/authMiddleware';
import { listUsers, getUserDetails, updateUserRole, deleteUser } from '../controllers/users.controller';

const router = Router();

// Solo superadmin puede acceder
router.use(authenticateToken, authorizeRoles('superadmin'));

router.get('/', listUsers);
router.get('/:id', getUserDetails);
router.patch('/:id/role', updateUserRole);
router.delete('/:id', deleteUser);

export default router;
