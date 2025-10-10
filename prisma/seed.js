// prisma/seed.ts
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  // Datos del admin - usar variables de entorno si están disponibles
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@confiaticket.com';
  const plain = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'Admin123!';

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

  console.log('✅ Superadmin creado/actualizado:');
  console.log('   Email:', admin.email);
  console.log('   Password:', plain);
  console.log('   Rol:', admin.role);
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




