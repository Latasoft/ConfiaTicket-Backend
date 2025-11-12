// src/prisma/client.ts
import { PrismaClient, Prisma } from '@prisma/client';
import { env } from '../config/env';

declare global {
  // Evita múltiples instancias en dev (hot reload)
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

// 👇 Array mutable tipado: sin "as const"
const log: Prisma.LogLevel[] = env.IS_PROD
  ? ['error', 'warn']
  : ['query', 'info', 'warn', 'error'];

// ✅ Configuración del pool de conexiones para Supabase + PgBouncer
// IMPORTANTE: Con PgBouncer, estas son conexiones POR INSTANCIA de Node.js
// PgBouncer maneja el pooling global (soporta 1000+ conexiones totales)
//
// Free tier: 10-15 conexiones por instancia
// Pro tier: 20-50 conexiones por instancia
// 
// El límite real lo define DATABASE_URL, estos son valores por defecto si no se especifica
const CONNECTION_LIMIT = env.IS_PROD ? 30 : 5; // 30 para producción con PgBouncer
const CONNECTION_TIMEOUT = 30000; // 30 segundos
const POOL_TIMEOUT = 30000; // 30 segundos
const IDLE_TIMEOUT = 300000; // 5 minutos (libera conexiones inactivas rápido)
const QUERY_TIMEOUT = 15000; // 15 segundos máximo por query

// Construir DATABASE_URL con parámetros de pool optimizados
function getDatabaseUrl(): string {
  const baseUrl = env.DATABASE_URL || '';
  
  if (!baseUrl) {
    throw new Error('DATABASE_URL no está configurada');
  }

  // Si ya tiene parámetros de pool, no los duplicamos
  if (baseUrl.includes('connection_limit') || baseUrl.includes('pool_timeout')) {
    return baseUrl;
  }

  // Agregar parámetros de pool optimizados para alta concurrencia
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}connection_limit=${CONNECTION_LIMIT}&pool_timeout=${POOL_TIMEOUT}&connect_timeout=${CONNECTION_TIMEOUT}&statement_timeout=${QUERY_TIMEOUT}`;
}

const prisma =
  globalThis.prisma ??
  new PrismaClient({
    log,
    errorFormat: env.IS_PROD ? 'minimal' : 'pretty',
    datasources: {
      db: {
        url: getDatabaseUrl(),
      },
    },
  });

// ✅ Logging de eventos de conexión para debugging
if (env.IS_PROD) {
  prisma.$on('query' as never, (e: any) => {
    // Log solo queries que tarden más de 1 segundo
    if (e.duration > 1000) {
      console.warn(`⚠️ Query lenta (${e.duration}ms): ${e.query.substring(0, 100)}...`);
    }
  });

  prisma.$on('error' as never, (e: any) => {
    console.error('❌ Error de Prisma:', e);
  });
}

// ✅ Limpieza periódica de conexiones idle (solo en producción)
if (env.IS_PROD) {
  setInterval(async () => {
    try {
      // Ping a la base de datos para mantener la conexión activa
      await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      console.error('Error en health check de Prisma:', error);
      // Intentar reconectar
      try {
        await prisma.$disconnect();
        await prisma.$connect();
        console.log('Prisma: Reconexión exitosa');
      } catch (reconnectError) {
        console.error('Error al reconectar Prisma:', reconnectError);
      }
    }
  }, IDLE_TIMEOUT); // Cada 10 minutos
}

if (!env.IS_PROD) {
  globalThis.prisma = prisma;
}

export default prisma;


