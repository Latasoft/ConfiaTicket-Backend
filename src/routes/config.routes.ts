// src/routes/config.routes.ts
import { Router } from 'express';
import { getBusinessRules } from '../controllers/config.controller';

const router = Router();

router.get('/business-rules', getBusinessRules);

export default router;
