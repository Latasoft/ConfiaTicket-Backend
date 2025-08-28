// src/server.ts
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { env } from './config/env';

// Routers existentes
import authRoutes from './routes/auth.routes';
import eventRoutes from './routes/events.routes';
import organizersRoutes from './routes/organizers.routes';
import bookingsRoutes from './routes/bookings.routes';
import organizerApplicationRoutes from './routes/organizerApplication.routes';

// Routers nuevos
import organizerEventsRouter from './routes/organizer.events.routes';
import adminEventsRouter from './routes/admin.events.routes';
import adminUsersRouter from './routes/admin.users.routes';
import adminOrganizerAppsRouter from './routes/admin.organizerApplications.routes';

// ⭐ Nuevos: pagos
import paymentsRoutes from './routes/payments.routes';

// ⭐ Nuevos: flujo de tickets (subida/aprobación/descarga)
import organizerTicketsRoutes from './routes/organizer.tickets.routes';
import adminTicketsRoutes from './routes/admin.tickets.routes';
import ticketsRoutes from './routes/tickets.routes';

const app = express();

/* ====================== Config básica ====================== */

// Confía en proxy (útil si hay Nginx/Render/Heroku)
app.set('trust proxy', 1);

// CORS: permite múltiples orígenes separados por coma en FRONTEND_URL
const ORIGINS = (env.FRONTEND_URL || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: ORIGINS.length ? ORIGINS : undefined, // si no hay FRONTEND_URL, permite todos
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
);

// Body parsers con límites razonables
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Middleware de log simple (desarrollo)
app.use((req, _res, next) => {
  console.log('[REQ]', req.method, req.originalUrl);
  next();
});

/* =================== Uploads: público vs privado =================== */
// Base configurable (por si usas un volumen distinto)
const UPLOADS_BASE = env.UPLOAD_DIR
  ? path.resolve(env.UPLOAD_DIR)
  : path.join(process.cwd(), 'uploads');

// Público (imágenes de eventos, etc.)
const PUBLIC_UPLOADS_DIR = path.join(UPLOADS_BASE, 'public');
// Privado (tickets PDF/PNG/JPG, NO se sirve estáticamente)
const PRIVATE_UPLOADS_DIR = path.join(UPLOADS_BASE, 'private');

for (const p of [PUBLIC_UPLOADS_DIR, PRIVATE_UPLOADS_DIR]) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// 👉 Sólo servimos estático el directorio PÚBLICO
app.use(
  '/uploads',
  express.static(PUBLIC_UPLOADS_DIR, {
    fallthrough: true,
    maxAge: '7d',
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=604800'); // 7d
    },
  })
);

/* ======================== Rutas base ======================== */

app.get('/', (_req, res) => res.send('API Portal Entradas funcionando 🚀'));

// Endpoint de salud para monitoreo
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

/* ========================= Rutas API ======================== */

// Existentes
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/organizers', organizersRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/organizer-applications', organizerApplicationRoutes);

// Nuevas (admin/organizer)
app.use('/api/organizer/events', organizerEventsRouter);                 // CRUD del organizador
app.use('/api/admin/events', adminEventsRouter);                         // Panel superadmin (eventos)
app.use('/api/admin/users', adminUsersRouter);                           // Panel superadmin (usuarios)
app.use('/api/admin/organizer-applications', adminOrganizerAppsRouter);  // Panel superadmin (solicitudes)

// ⭐ Pagos Webpay/Transbank
app.use('/api/payments', paymentsRoutes);

// ⭐ Flujo de tickets
// - Organizador: POST /api/organizer/reservations/:id/ticket (subir archivo)  [privado]
// - Admin: GET /api/admin/tickets/pending; GET /api/admin/reservations/:id/ticket-file
//         POST /api/admin/reservations/:id/approve-ticket; POST /api/admin/reservations/:id/reject-ticket
// - Comprador: GET /api/tickets/:id/status; GET /api/tickets/:id/file; GET /api/tickets/:id/download
app.use('/api/organizer', organizerTicketsRoutes);
app.use('/api/admin', adminTicketsRoutes);
app.use('/api/tickets', ticketsRoutes);

/* ======================= Manejo de errores ======================= */

// 404 (siempre al final de las rutas)
app.use((_req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// Error handler (después del 404)
app.use(
  (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Error no controlado:', err);
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({ error: err?.message || 'Error interno del servidor' });
  }
);

/* ====================== Arranque del servidor ===================== */

const port = Number(env.PORT) || 4000;

// Exporta app para tests e inicia solo fuera de test
if ((process.env.NODE_ENV ?? 'development') !== 'test') {
  app.listen(port, () => {
    console.log(`Servidor corriendo en puerto ${port}`);
    if (ORIGINS.length) console.log('CORS origins:', ORIGINS.join(', '));
    console.log('Uploads base:', UPLOADS_BASE);
    console.log('Public uploads:', PUBLIC_UPLOADS_DIR);
    console.log('Private uploads:', PRIVATE_UPLOADS_DIR);
  });
}

export default app;












