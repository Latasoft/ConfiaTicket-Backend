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
  ? ['error']
  : ['query', 'info', 'warn', 'error'];

const prisma =
  globalThis.prisma ??
  new PrismaClient({
    log,
    errorFormat: env.IS_PROD ? 'minimal' : 'pretty',
    // Usa DATABASE_URL explícitamente si viene por ENV
    datasources: env.DATABASE_URL ? { db: { url: env.DATABASE_URL } } : undefined,
  });

if (!env.IS_PROD) {
  globalThis.prisma = prisma;
}

export default prisma;


