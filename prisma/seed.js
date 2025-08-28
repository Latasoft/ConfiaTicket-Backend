// prisma/seed.js
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

// Igual que en el backend: "XXXXXXXX-D"
function normalizeRut(input) {
  const raw = String(input || '').replace(/\./g, '').replace(/-/g, '').toUpperCase();
  const m = raw.match(/^(\d{7,8})([0-9K])$/);
  if (!m) return '';
  return `${m[1]}-${m[2]}`;
}

async function upsertUser(params) {
  const {
    name,
    email,
    password,              // plano; acá lo hasheamos
    role,                  // 'superadmin' | 'organizer' | 'buyer'
    rut = null,
    canSell = true,
    isVerified = false,
  } = params;

  const hash = await bcrypt.hash(password, 10);
  const normRut = rut ? normalizeRut(rut) : null;

  const user = await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    update: {
      name,
      role,
      rut: normRut,
      canSell,
      isVerified,
      isActive: true,
      password: hash,
    },
    create: {
      name,
      email: email.toLowerCase(),
      password: hash,
      role,
      rut: normRut,
      canSell,
      isVerified,
      isActive: true,
    },
    select: { id: true, email: true, role: true, rut: true },
  });

  console.log('Seeded:', user);
}

async function main() {
  // SUPERADMIN
  await upsertUser({
    name: 'Admin Principal',
    email: 'admin@local.test',
    password: 'SuperFuerte#2025',
    role: 'superadmin',
    rut: null,          // opcional
    canSell: true,
    isVerified: true,
  });

  // (Opcionales) usuarios de prueba
  await upsertUser({
    name: 'Organizador Verificado',
    email: 'organizer@example.com',
    password: 'Org#2025Seguro',
    role: 'organizer',
    rut: '12345678-5',
    canSell: true,
    isVerified: true,
  });

  await upsertUser({
    name: 'Buyer Uno',
    email: 'buyer@example.com',
    password: 'Buyer#2025Seguro',
    role: 'buyer',
    rut: '98765432-K',
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });




