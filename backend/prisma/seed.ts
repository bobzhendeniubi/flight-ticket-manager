/**
 * Development seed: creates an admin user + one agent + two sample flights with schedules and seats.
 * Idempotent — safe to run multiple times.
 *
 * Run: npm run prisma:seed  (from backend/)
 */
import { PrismaClient, UserRole, CabinClass } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const adminEmail = 'admin@ftm.local';
  const agentEmail = 'agent@ftm.local';
  const customerEmail = 'customer@ftm.local';
  const devPasswordHash = await argon2.hash('Password123!', { type: argon2.argon2id });

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      passwordHash: devPasswordHash,
      role: UserRole.ADMIN,
      displayName: 'Dev Admin',
      emailVerified: true,
    },
  });

  const customer = await prisma.user.upsert({
    where: { email: customerEmail },
    update: {},
    create: {
      email: customerEmail,
      passwordHash: devPasswordHash,
      role: UserRole.CUSTOMER,
      displayName: 'Dev Customer',
      emailVerified: true,
    },
  });

  const agentUser = await prisma.user.upsert({
    where: { email: agentEmail },
    update: {},
    create: {
      email: agentEmail,
      passwordHash: devPasswordHash,
      role: UserRole.AGENT,
      displayName: 'Dev Agent',
      emailVerified: true,
    },
  });

  await prisma.agent.upsert({
    where: { userId: agentUser.id },
    update: {},
    create: {
      userId: agentUser.id,
      companyName: 'Dev Travel Co.',
      contactName: 'Dev Agent',
      contactPhone: '+8613800000000',
      prepaymentBalance: 10000,
    },
  });

  // Sample flights: PEK ↔ PVG, dep in 14 days
  const depDate = new Date();
  depDate.setDate(depDate.getDate() + 14);
  depDate.setUTCHours(1, 0, 0, 0); // 09:00 Asia/Shanghai
  const arrDate = new Date(depDate.getTime() + 2 * 60 * 60 * 1000);

  const outbound = await prisma.flight.upsert({
    where: { flightNumber: 'FT1001' },
    update: {},
    create: {
      flightNumber: 'FT1001',
      originCode: 'PEK',
      destinationCode: 'PVG',
      aircraftType: 'A320',
    },
  });

  const returnFlight = await prisma.flight.upsert({
    where: { flightNumber: 'FT1002' },
    update: {},
    create: {
      flightNumber: 'FT1002',
      originCode: 'PVG',
      destinationCode: 'PEK',
      aircraftType: 'A320',
    },
  });

  const outSchedule = await prisma.flightSchedule.create({
    data: {
      flightId: outbound.id,
      departureTime: depDate,
      arrivalTime: arrDate,
      departureTz: 'Asia/Shanghai',
      arrivalTz: 'Asia/Shanghai',
      seatClasses: {
        create: [
          { cabin: CabinClass.ECONOMY, capacity: 150, basePrice: 850 },
          { cabin: CabinClass.BUSINESS, capacity: 20, basePrice: 3200 },
        ],
      },
    },
  });

  const returnDep = new Date(depDate.getTime() + 5 * 24 * 60 * 60 * 1000);
  const returnArr = new Date(returnDep.getTime() + 2 * 60 * 60 * 1000);
  await prisma.flightSchedule.create({
    data: {
      flightId: returnFlight.id,
      departureTime: returnDep,
      arrivalTime: returnArr,
      departureTz: 'Asia/Shanghai',
      arrivalTz: 'Asia/Shanghai',
      seatClasses: {
        create: [
          { cabin: CabinClass.ECONOMY, capacity: 150, basePrice: 880 },
          { cabin: CabinClass.BUSINESS, capacity: 20, basePrice: 3300 },
        ],
      },
    },
  });

  // eslint-disable-next-line no-console
  console.log('✅ seed complete:', {
    admin: admin.email,
    customer: customer.email,
    agent: agentUser.email,
    outboundSchedule: outSchedule.id,
    devPassword: 'Password123!',
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
