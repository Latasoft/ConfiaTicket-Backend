// prisma/seed.ts
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function seedConfig() {
  await prisma.ticketLimitConfig.upsert({
    where: { eventType: 'RESALE' },
    update: {},
    create: {
      eventType: 'RESALE',
      minCapacity: 1,
      maxCapacity: 4,
    },
  });

  await prisma.ticketLimitConfig.upsert({
    where: { eventType: 'OWN' },
    update: {},
    create: {
      eventType: 'OWN',
      minCapacity: 1,
      maxCapacity: 999999,
    },
  });

  const priceLimitExists = await prisma.priceLimitConfig.findFirst();
  if (!priceLimitExists) {
    await prisma.priceLimitConfig.create({
      data: {
        minPrice: 0,
        maxPrice: 10000000,
        resaleMarkupPercent: 30,
      },
    });
  }

  const fieldLimits = [
    { fieldName: 'TITLE', maxLength: 120, context: 'EVENT' },
    { fieldName: 'DESCRIPTION', maxLength: 4000, context: 'EVENT' },
    { fieldName: 'VENUE', maxLength: 120, context: 'EVENT' },
    { fieldName: 'CITY', maxLength: 120, context: 'EVENT' },
    { fieldName: 'COMMUNE', maxLength: 120, context: 'EVENT' },
    { fieldName: 'COVER_URL', maxLength: 1024, context: 'EVENT' },
    { fieldName: 'PAYOUT_BANK', maxLength: 80, context: 'PAYOUT' },
    { fieldName: 'PAYOUT_TYPE', maxLength: 16, context: 'PAYOUT' },
    { fieldName: 'PAYOUT_NUMBER', maxLength: 30, context: 'PAYOUT' },
    { fieldName: 'PAYOUT_HOLDER_NAME', maxLength: 100, context: 'PAYOUT' },
    { fieldName: 'PAYOUT_HOLDER_RUT', maxLength: 16, context: 'PAYOUT' },
    { fieldName: 'TICKET_CODE', maxLength: 100, context: 'TICKET' },
    { fieldName: 'TICKET_ROW', maxLength: 20, context: 'TICKET' },
    { fieldName: 'TICKET_SEAT', maxLength: 20, context: 'TICKET' },
    { fieldName: 'TICKET_ZONE', maxLength: 50, context: 'TICKET' },
    { fieldName: 'TICKET_LEVEL', maxLength: 50, context: 'TICKET' },
    { fieldName: 'TICKET_SECTION', maxLength: 100, context: 'TICKET' },
    { fieldName: 'TICKET_DESCRIPTION', maxLength: 200, context: 'TICKET' },
  ];

  for (const field of fieldLimits) {
    await prisma.fieldLimitConfig.upsert({
      where: { fieldName: field.fieldName },
      update: {},
      create: field,
    });
  }

  const systemConfigs = [
    {
      category: 'BUSINESS_RULE',
      key: 'ALLOWED_ACCOUNT_TYPES',
      value: 'corriente,vista,ahorro,rut',
      dataType: 'STRING',
      description: 'Tipos de cuenta bancaria permitidos',
      isEditable: true,
    },
  ];

  for (const config of systemConfigs) {
    await prisma.systemConfig.upsert({
      where: { key: config.key },
      update: {},
      create: config,
    });
  }

  // Platform Fee Config - usar variable de entorno si está disponible
  const feeBpsFromEnv = process.env.PSP_APP_FEE_BPS ? parseInt(process.env.PSP_APP_FEE_BPS) : null;
  const defaultFeeBps = 250; // 2.5% por defecto
  
  const platformFeeExists = await prisma.platformFeeConfig.findFirst();
  if (!platformFeeExists) {
    await prisma.platformFeeConfig.create({
      data: {
        feeBps: feeBpsFromEnv ?? defaultFeeBps,
        // description: null, // Campo vacío por defecto para que se muestre el placeholder
      },
    });
  } else if (feeBpsFromEnv !== null) {
    // Si existe en .env, sobrescribir el valor en BD
    await prisma.platformFeeConfig.update({
      where: { id: platformFeeExists.id },
      data: { feeBps: feeBpsFromEnv },
    });
  }
}

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

  // Seed de configuración
  await seedConfig();
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




