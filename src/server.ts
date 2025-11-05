// src/server.ts
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import { env } from './config/env';
import prisma from './prisma/client';

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
import adminDocumentsRouter from './routes/admin.documents.routes';

import paymentsRoutes from './routes/payments.routes';

import organizerResaleTicketsRoutes from './routes/organizer.resaleTickets.routes';
import organizerOwnEventSectionsRoutes from './routes/organizer.ownEventSections.routes';
import adminTicketsRoutes from './routes/admin.tickets.routes';
import ticketsRoutes from './routes/tickets.routes';

import pspRoutes from './routes/psp.routes';

import kushkiAdapter from './routes/payouts.adapter.kushki.routes';

import adminPayoutsRoutes from './routes/admin.payouts.routes';

import configRoutes from './routes/config.routes';
import adminConfigRoutes from './routes/admin.config.routes';
import organizerTicketValidationRoutes from './routes/organizer.ticketValidation.routes';
import resaleTicketValidationRoutes from './routes/resaleTicketValidation.routes';
import claimsRoutes from './routes/claims.routes';
import documentsRoutes from './routes/documents.routes';

import { startPayoutsReconcileJob } from './jobs/payouts.reconcile.job';
import { startPayoutsRetryJob } from './jobs/payouts.retry.job';
import { startCleanExpiredReservationsJob } from './jobs/cleanExpiredReservations.job';

const app = express();

/* ====================== Config básica ====================== */

app.set('trust proxy', 1);
app.disable('x-powered-by');

// Seguridad base
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());

// CORS estricto (usa env.CORS_ORIGINS si está disponible)
const ORIGINS = (env as any).CORS_ORIGINS?.length ? (env as any).CORS_ORIGINS as string[] :
  (env.FRONTEND_URL || '').split(',').map(s => s.trim()).filter(Boolean);

if (ORIGINS.length === 0) {
  console.error('ERROR: CORS_ORIGINS está vacío. Por seguridad, el servidor no iniciará.');
  console.error('   Configura CORS_ORIGINS o FRONTEND_URL en tu archivo .env');
  if (env.IS_PROD) {
    process.exit(1); // Detener servidor en producción
  } else {
    console.warn('DESARROLLO: Permitiendo localhost por defecto');
    ORIGINS.push('http://localhost:3000', 'http://localhost:5173');
  }
}

console.log('CORS configurado para origins:', ORIGINS);

app.use(
  cors({
    origin(origin, cb) {
      // Rechazar requests sin Origin header (excepto health checks específicos)
      if (!origin) {
        // Permitir solo para rutas de health check
        return cb(null, true); // Temporal: se puede restringir más
      }
      if (ORIGINS.includes(origin)) return cb(null, true);
      console.warn(`CORS bloqueado: ${origin}`);
      return cb(new Error(`CORS: Origin no permitido: ${origin}`), false);
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key', 'X-Request-Id'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
);

// Rate limiters diferenciados por tipo de endpoint
const strictAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // Solo 5 intentos por 15 min
  message: { error: 'Demasiados intentos. Por favor, intenta de nuevo en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // 10 intentos por 15 min
  message: { error: 'Demasiados intentos. Por favor, intenta de nuevo en 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 60, // 60 req/min por IP
  message: { error: 'Demasiadas solicitudes. Por favor, intenta de nuevo en un momento.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);

// Logs
app.use(morgan(env.IS_PROD ? 'combined' : 'dev'));

// Parsers de webhooks con raw body (antes de json global)
app.use(
  '/api/payments/payouts/webhook',
  express.json({
    limit: '256kb',
    verify: (req: any, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  })
);
app.use('/api/psp/webhook', express.raw({ type: '*/*', limit: '256kb' }));
app.use('/adapter/kushki/webhooks', express.raw({ type: '*/*', limit: '256kb' }));

// Parsers globales
app.use(
  express.json({
    limit: '1mb',
    verify: (req: any, _res, buf) => {
      if (!req.rawBody) req.rawBody = Buffer.from(buf);
    },
  })
);
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

/* =================== Uploads: público vs privado =================== */
const UPLOADS_BASE = env.UPLOAD_DIR
  ? path.resolve(env.UPLOAD_DIR)
  : path.join(process.cwd(), 'uploads');

const PUBLIC_UPLOADS_DIR = path.join(UPLOADS_BASE, 'public');
const PRIVATE_UPLOADS_DIR = path.join(UPLOADS_BASE, 'private');
const DOCUMENTS_UPLOADS_DIR = path.join(UPLOADS_BASE, 'documents'); // Cédulas de identidad
const CLAIMS_UPLOADS_DIR = path.join(UPLOADS_BASE, 'claims');       // Evidencia de reclamos
const TICKETS_UPLOADS_DIR = path.join(UPLOADS_BASE, 'tickets');

for (const p of [PUBLIC_UPLOADS_DIR, PRIVATE_UPLOADS_DIR, DOCUMENTS_UPLOADS_DIR, CLAIMS_UPLOADS_DIR, TICKETS_UPLOADS_DIR]) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// Servir archivos públicos
app.use(
  '/uploads',
  express.static(PUBLIC_UPLOADS_DIR, {
    fallthrough: true,
    maxAge: '7d',
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=604800');
    },
  })
);

// Servir archivos de tickets (públicos)
app.use(
  '/uploads/tickets',
  express.static(TICKETS_UPLOADS_DIR, {
    fallthrough: true,
    maxAge: '7d',
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=604800');
    },
  })
);

// NOTA: Los documentos (cédulas de identidad) y claims (evidencia de reclamos) 
// NO se sirven públicamente. Se acceden mediante endpoints protegidos:

/* ======================== Rutas base ======================== */

app.get('/', (_req, res) => res.send('API Portal Entradas funcionando 🚀'));
app.get('/health', (_req, res) => res.status(200).send('ok')); // para Render
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true })); // compat

/* ========================= Rutas API ======================== */

// Existentes
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/organizers', organizersRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/organizer-applications', organizerApplicationRoutes);

app.use('/api/config', configRoutes);

app.use('/api/organizer/events', organizerEventsRouter);
app.use('/api/organizer/ticket-validation', organizerTicketValidationRoutes);
app.use('/api/resale-tickets', resaleTicketValidationRoutes);
app.use('/api/admin/events', adminEventsRouter);
app.use('/api/admin/users', adminUsersRouter);
app.use('/api/admin/organizer-applications', adminOrganizerAppsRouter);
app.use('/api/admin/documents', adminDocumentsRouter);
app.use('/api/admin/config', adminConfigRoutes);

app.use('/api/payments', paymentsRoutes);
app.use('/api/claims', claimsRoutes);
app.use('/api/documents', documentsRoutes);

// ⭐ PSP Marketplace (split/escrow)
app.use('/api/psp', pspRoutes);

// ⭐ Adapter HTTP de payouts (Kushki)
app.use('/adapter/kushki', kushkiAdapter);

// ⭐ Flujo de tickets
// reventa
app.use('/api/organizer', organizerResaleTicketsRoutes);
// evento propio
app.use('/api/organizer', organizerOwnEventSectionsRoutes);
// admin y comprador
app.use('/api/admin', adminTicketsRoutes);
app.use('/api/tickets', ticketsRoutes);

// ⭐ Admin payouts (retry/reconcile manual)
app.use('/api/admin/payouts', adminPayoutsRoutes);

/* ======================= Manejo de errores ======================= */

app.use((_req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

app.use(
  (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    if (!env.IS_PROD) console.error('Error no controlado:', err);
    res.status(status).json({ error: err?.message || 'Error interno del servidor' });
  }
);

/* ====================== Arranque del servidor ===================== */

const port = Number(env.PORT) || 4000;
const host = '0.0.0.0';

// Jobs (omitir en tests)
if ((process.env.NODE_ENV ?? 'development') !== 'test') {
  startPayoutsReconcileJob();
  startPayoutsRetryJob();
  startCleanExpiredReservationsJob(5); // Ejecutar cada 5 minutos
}

let server: import('http').Server | undefined;

if ((process.env.NODE_ENV ?? 'development') !== 'test') {
  server = app.listen(port, host, () => {
    console.log(`Servidor corriendo en http://${host}:${port}`);
    if (ORIGINS.length) console.log('CORS origins:', ORIGINS.join(', '));
    console.log('Uploads base:', UPLOADS_BASE);
    console.log('Public uploads:', PUBLIC_UPLOADS_DIR);
    console.log('Private uploads:', PRIVATE_UPLOADS_DIR);
  });
}

// Graceful shutdown para Render/containers
async function shutdown(signal: string) {
  console.log(`\nRecibido ${signal}, cerrando servidor...`);
  try {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await prisma.$disconnect();
  } catch (e) {
    console.error('Error al cerrar:', e);
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;




















