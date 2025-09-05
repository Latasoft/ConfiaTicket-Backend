// prisma/seed.ts
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim();
  const plain = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  if (!email || !plain) {
    throw new Error(
      'Faltan BOOTSTRAP_ADMIN_EMAIL y/o BOOTSTRAP_ADMIN_PASSWORD en las envs.'
    );
  }

  const passwordHash = await bcrypt.hash(plain, 12);

  // upsert idempotente por email
  const admin = await prisma.user.upsert({
    where: { email },
    update: {
      role: 'superadmin',
      isActive: true,
      deletedAt: null,
      password: passwordHash,
      // tokenVersion opcional (mantener o resetear)
      // tokenVersion: 0,
    },
    create: {
      email,
      name: 'Super Admin',
      role: 'superadmin',
      isActive: true,
      password: passwordHash,
      // completa otros campos requeridos por tu schema si los tienes
    },
    select: { id: true, email: true, role: true, isActive: true, createdAt: true },
  });

  console.log('✅ Superadmin listo:', admin);
  console.log('   Email:', admin.email);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error('❌ Seed error:', e?.message || e);
    await prisma.$disconnect();
    process.exit(1);
  });




