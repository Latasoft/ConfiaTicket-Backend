// src/routes/organizer.ownEventSections.routes.ts
// Rutas para gestión de secciones de eventos propios (own)
import { Router } from 'express';
import * as sectionsCtrl from '../controllers/organizer.ownEventSections.controller';

const router = Router();

// CRUD de secciones para eventos OWN
router.post('/events/:eventId/sections', sectionsCtrl.createSection);
router.get('/events/:eventId/sections', sectionsCtrl.listSections);
router.get('/events/:eventId/sections/:sectionId', sectionsCtrl.getSection);
router.put('/events/:eventId/sections/:sectionId', sectionsCtrl.updateSection);
router.delete('/events/:eventId/sections/:sectionId', sectionsCtrl.deleteSection);

export default router;
