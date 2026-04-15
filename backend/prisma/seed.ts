/**
 * 开发环境 seed：创建管理员、多层代理、客户，以及若干示例航班。
 * 幂等 — 可重复运行。
 *
 * Run: npm run prisma:seed  (from backend/)
 */
import { PrismaClient, UserRole, CabinClass } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

// 8 条示例航班：京沪、京广、沪广、沪厦、京深、广深 等自营航线
const FLIGHT_SEED: Array<{
  flightNumber: string;
  origin: string;
  dest: string;
  departHour: number; // 本地时间
  durationHrs: number;
  aircraft: string;
  econPrice: number;
  bizPrice: number;
  offsetDays: number; // 离今天第几天
}> = [
  { flightNumber: 'FT1001', origin: 'PEK', dest: 'PVG', departHour: 9,  durationHrs: 2,   aircraft: 'A320', econPrice: 850,  bizPrice: 3200, offsetDays: 3 },
  { flightNumber: 'FT1002', origin: 'PVG', dest: 'PEK', departHour: 18, durationHrs: 2,   aircraft: 'A320', econPrice: 880,  bizPrice: 3300, offsetDays: 5 },
  { flightNumber: 'FT1003', origin: 'PEK', dest: 'CAN', departHour: 8,  durationHrs: 3.5, aircraft: 'B737', econPrice: 1100, bizPrice: 4200, offsetDays: 4 },
  { flightNumber: 'FT1004', origin: 'CAN', dest: 'PEK', departHour: 20, durationHrs: 3.5, aircraft: 'B737', econPrice: 1150, bizPrice: 4300, offsetDays: 7 },
  { flightNumber: 'FT1005', origin: 'PVG', dest: 'CAN', departHour: 14, durationHrs: 2.5, aircraft: 'A320', econPrice: 780,  bizPrice: 2900, offsetDays: 4 },
  { flightNumber: 'FT1006', origin: 'PVG', dest: 'XMN', departHour: 11, durationHrs: 1.5, aircraft: 'A319', econPrice: 620,  bizPrice: 2200, offsetDays: 6 },
  { flightNumber: 'FT1007', origin: 'PEK', dest: 'SZX', departHour: 7,  durationHrs: 3,   aircraft: 'A321', econPrice: 1050, bizPrice: 3900, offsetDays: 5 },
  { flightNumber: 'FT1008', origin: 'CAN', dest: 'SZX', departHour: 16, durationHrs: 1,   aircraft: 'A319', econPrice: 480,  bizPrice: 1600, offsetDays: 3 },
];

async function main() {
  const password = 'Password123!';
  const hash = await argon2.hash(password, { type: argon2.argon2id });

  // ── 用户 ──
  const admin = await prisma.user.upsert({
    where: { email: 'admin@ftm.local' },
    update: {},
    create: {
      email: 'admin@ftm.local',
      passwordHash: hash,
      role: UserRole.ADMIN,
      displayName: '系统管理员',
      emailVerified: true,
    },
  });

  const customer = await prisma.user.upsert({
    where: { email: 'customer@ftm.local' },
    update: {},
    create: {
      email: 'customer@ftm.local',
      passwordHash: hash,
      role: UserRole.CUSTOMER,
      displayName: '演示客户',
      emailVerified: true,
    },
  });

  // 1 级代理
  const agent1User = await prisma.user.upsert({
    where: { email: 'agent1@ftm.local' },
    update: {},
    create: {
      email: 'agent1@ftm.local',
      passwordHash: hash,
      role: UserRole.AGENT,
      displayName: '1级代理 · 总代',
      emailVerified: true,
    },
  });

  const agent1 = await prisma.agent.upsert({
    where: { userId: agent1User.id },
    update: {},
    create: {
      userId: agent1User.id,
      companyName: '总代旅行社',
      contactName: '王总代',
      contactPhone: '+8613800000001',
      prepaymentBalance: 50000,
      tier: 1,
    },
  });

  // 2 级代理（归属 agent1）
  const agent2User = await prisma.user.upsert({
    where: { email: 'agent2@ftm.local' },
    update: {},
    create: {
      email: 'agent2@ftm.local',
      passwordHash: hash,
      role: UserRole.AGENT,
      displayName: '2级代理 · 区代',
      emailVerified: true,
    },
  });

  const agent2 = await prisma.agent.upsert({
    where: { userId: agent2User.id },
    update: {},
    create: {
      userId: agent2User.id,
      companyName: '区代旅行社',
      contactName: '李区代',
      contactPhone: '+8613800000002',
      prepaymentBalance: 10000,
      parentAgentId: agent1.id,
      tier: 2,
    },
  });

  // 3 级代理（归属 agent2）
  const agent3User = await prisma.user.upsert({
    where: { email: 'agent3@ftm.local' },
    update: {},
    create: {
      email: 'agent3@ftm.local',
      passwordHash: hash,
      role: UserRole.AGENT,
      displayName: '3级代理 · 门店',
      emailVerified: true,
    },
  });

  const agent3 = await prisma.agent.upsert({
    where: { userId: agent3User.id },
    update: {},
    create: {
      userId: agent3User.id,
      companyName: '门店旅行社',
      contactName: '张门店',
      contactPhone: '+8613800000003',
      prepaymentBalance: 3000,
      parentAgentId: agent2.id,
      tier: 3,
    },
  });

  // ── 航班 ──
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  let scheduleCount = 0;

  for (const f of FLIGHT_SEED) {
    const flight = await prisma.flight.upsert({
      where: { flightNumber: f.flightNumber },
      update: {},
      create: {
        flightNumber: f.flightNumber,
        originCode: f.origin,
        destinationCode: f.dest,
        aircraftType: f.aircraft,
      },
    });

    const dep = new Date(today);
    dep.setUTCDate(dep.getUTCDate() + f.offsetDays);
    // Asia/Shanghai 是 UTC+8，所以本地 hour -> UTC hour = hour - 8
    dep.setUTCHours(f.departHour - 8, 0, 0, 0);
    const arr = new Date(dep.getTime() + f.durationHrs * 60 * 60 * 1000);

    const existing = await prisma.flightSchedule.findFirst({
      where: { flightId: flight.id, departureTime: dep },
    });
    if (!existing) {
      await prisma.flightSchedule.create({
        data: {
          flightId: flight.id,
          departureTime: dep,
          arrivalTime: arr,
          departureTz: 'Asia/Shanghai',
          arrivalTz: 'Asia/Shanghai',
          seatClasses: {
            create: [
              { cabin: CabinClass.ECONOMY,  capacity: 150, basePrice: f.econPrice },
              { cabin: CabinClass.BUSINESS, capacity: 20,  basePrice: f.bizPrice },
            ],
          },
        },
      });
      scheduleCount++;
    }
  }

  // eslint-disable-next-line no-console
  console.log('✅ seed 完成', {
    admin: admin.email,
    customer: customer.email,
    '1级代理': agent1User.email,
    '2级代理(父=1级)': agent2User.email,
    '3级代理(父=2级)': agent3User.email,
    航班数: FLIGHT_SEED.length,
    新增班次: scheduleCount,
    开发密码: password,
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
