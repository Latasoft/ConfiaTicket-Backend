// prisma/seed.ts
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function seedConfig() {
  // TicketLimitConfig - solo crear si NO existe
  const resaleLimit = await prisma.ticketLimitConfig.findUnique({
    where: { eventType: 'RESALE' }
  });
  if (!resaleLimit) {
    await prisma.ticketLimitConfig.create({
      data: {
        eventType: 'RESALE',
        minCapacity: 1,
        maxCapacity: 4,
      },
    });
  }

  const ownLimit = await prisma.ticketLimitConfig.findUnique({
    where: { eventType: 'OWN' }
  });
  if (!ownLimit) {
    await prisma.ticketLimitConfig.create({
      data: {
        eventType: 'OWN',
        minCapacity: 1,
        maxCapacity: 999999,
      },
    });
  }

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

  // Solo crear FieldLimitConfig que NO existan
  for (const field of fieldLimits) {
    const existing = await prisma.fieldLimitConfig.findUnique({
      where: { fieldName: field.fieldName }
    });
    if (!existing) {
      await prisma.fieldLimitConfig.create({
        data: field,
      });
    }
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
    {
      category: 'BUSINESS_RULE',
      key: 'MAX_TICKETS_PER_PURCHASE',
      value: '4',
      dataType: 'INTEGER',
      description: 'Máximo de tickets que se pueden comprar por transacción',
      isEditable: true,
    },
    {
      category: 'BUSINESS_RULE',
      key: 'CLAIM_DEADLINE_HOURS',
      value: '48',
      dataType: 'INTEGER',
      description: 'Horas después del evento para crear un reclamo',
      isEditable: true,
    },
  ];

  // Solo crear SystemConfig que NO existan
  for (const config of systemConfigs) {
    const existing = await prisma.systemConfig.findUnique({
      where: { key: config.key }
    });
    if (!existing) {
      await prisma.systemConfig.create({
        data: config,
      });
    }
  }

  // Platform Fee Config - SOLO crear si no existe, NO sobrescribir
  const platformFeeExists = await prisma.platformFeeConfig.findFirst();
  if (!platformFeeExists) {
    const feeBpsFromEnv = process.env.PSP_APP_FEE_BPS ? parseInt(process.env.PSP_APP_FEE_BPS) : null;
    const defaultFeeBps = 250; // 2.5% por defecto
    
    await prisma.platformFeeConfig.create({
      data: {
        feeBps: feeBpsFromEnv ?? defaultFeeBps,
        // description: null, // Campo vacío por defecto para que se muestre el placeholder
      },
    });
  }
  // Si ya existe, NO tocar (permite edición desde admin panel)

  // Reservation Hold Config - SOLO crear si no existe
  const reservationHoldExists = await prisma.reservationHoldConfig.findFirst();
  if (!reservationHoldExists) {
    const holdMinutesFromEnv = process.env.RESERVATION_HOLD_MINUTES ? parseInt(process.env.RESERVATION_HOLD_MINUTES) : null;
    const defaultHoldMinutes = 15;
    
    await prisma.reservationHoldConfig.create({
      data: {
        holdMinutes: holdMinutesFromEnv ?? defaultHoldMinutes,
        description: 'Tiempo en minutos que una reserva se mantiene bloqueada antes de expirar',
      },
    });
  }
}

async function main() {
  // Datos del admin - usar variables de entorno si están disponibles
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@confiaticket.com';
  const plain = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'Admin123!';

  const passwordHash = await bcrypt.hash(plain, 12);

  // SOLO crear superadmin si NO existe (no sobrescribir)
  const existingAdmin = await prisma.user.findUnique({
    where: { email }
  });

  if (!existingAdmin) {
    const admin = await prisma.user.create({
      data: {
        email,
        name: 'Super Admin',
        role: 'superadmin',
        isActive: true,
        password: passwordHash,
        // completa otros campos requeridos por tu schema si los tienes
      },
      select: { id: true, email: true, role: true, isActive: true, createdAt: true },
    });

    console.log('✅ Superadmin creado:');
    console.log('   Email:', admin.email);
    console.log('   Password:', plain);
    console.log('   Rol:', admin.role);
  } else {
    console.log('ℹ️  Superadmin ya existe, no se modifica:');
    console.log('   Email:', existingAdmin.email);
    console.log('   Rol:', existingAdmin.role);
  }

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




