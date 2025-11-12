// src/middleware/dbHealthMiddleware.ts
import { Request, Response, NextFunction } from 'express';
import prisma from '../prisma/client';

let lastHealthCheck = Date.now();
let isHealthy = true;

/**
 * Middleware para verificar salud de la conexión a BD
 * Se ejecuta cada cierto tiempo para evitar overhead
 */
export async function dbHealthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const now = Date.now();
  const timeSinceLastCheck = now - lastHealthCheck;

  // Solo verificar cada 30 segundos
  if (timeSinceLastCheck < 30000 && isHealthy) {
    return next();
  }

  try {
    // Query simple y rápida para verificar conectividad
    await prisma.$queryRaw`SELECT 1`;
    lastHealthCheck = now;
    isHealthy = true;
    next();
  } catch (error) {
    console.error('❌ DB Health Check falló:', error);
    isHealthy = false;
    
    // Intentar reconectar
    try {
      await prisma.$disconnect();
      await prisma.$connect();
      console.log('✅ DB reconectada exitosamente');
      isHealthy = true;
      next();
    } catch (reconnectError) {
      console.error('❌ Error al reconectar:', reconnectError);
      res.status(503).json({
        error: 'Servicio temporalmente no disponible',
        message: 'La base de datos no está disponible. Intenta nuevamente en unos momentos.',
      });
    }
  }
}

/**
 * Endpoint de health check para monitoreo externo
 */
export async function healthCheckEndpoint(req: Request, res: Response) {
  try {
    const start = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    const duration = Date.now() - start;

    res.status(200).json({
      status: 'healthy',
      database: 'connected',
      responseTime: `${duration}ms`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
}
