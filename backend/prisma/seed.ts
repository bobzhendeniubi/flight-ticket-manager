/**
 * 开发环境 seed：管理员、多层代理、客户，以及 QH9588/QH9589 两条自营航班的未来 14 天班次。
 * 幂等 — 可重复运行（会清理掉不在列表里的历史航班，保持 DB 和代码一致）。
 *
 * Run: npm run prisma:seed  (from backend/)
 */
import { PrismaClient, UserRole, CabinClass } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

// ── 我们目前自营的两条航班 ─────────────────────────────────────────────
// QH9588  北京首都 → 上海浦东  09:00 起飞
// QH9589  上海浦东 → 北京首都  18:30 起飞
const FLIGHT_SEED = [
  {
    flightNumber: 'QH9588',
    origin: 'PEK',
    dest: 'PVG',
    departHour: 9,
    departMinute: 0,
    durationMinutes: 120,
    aircraft: 'Airbus A320',
    econCapacity: 150,
    econPrice: 1180,
    bizCapacity: 20,
    bizPrice: 3980,
  },
  {
    flightNumber: 'QH9589',
    origin: 'PVG',
    dest: 'PEK',
    departHour: 18,
    departMinute: 30,
    durationMinutes: 120,
    aircraft: 'Airbus A320',
    econCapacity: 150,
    econPrice: 1280,
    bizCapacity: 20,
    bizPrice: 3980,
  },
] as const;

// 未来多少天每天各一班
const DAYS_OUT = 14;

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

  await prisma.agent.upsert({
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

  // ── 清理不在列表里的历史航班（只在没有订单关联时） ──
  const keepFlightNumbers = FLIGHT_SEED.map((f) => f.flightNumber);
  const toRemove = await prisma.flight.findMany({
    where: { flightNumber: { notIn: keepFlightNumbers } },
    include: {
      schedules: { include: { orderItems: { take: 1 } } },
    },
  });
  let removedFlights = 0;
  for (const f of toRemove) {
    const hasOrders = f.schedules.some((s) => s.orderItems.length > 0);
    if (hasOrders) continue; // 保留有订单的
    // cascade: delete schedules (which cascade-deletes seat classes)
    await prisma.flightSchedule.deleteMany({ where: { flightId: f.id } });
    await prisma.flight.delete({ where: { id: f.id } });
    removedFlights++;
  }

  // ── 航班 ──
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  let newSchedules = 0;

  for (const f of FLIGHT_SEED) {
    const flight = await prisma.flight.upsert({
      where: { flightNumber: f.flightNumber },
      update: {
        originCode: f.origin,
        destinationCode: f.dest,
        aircraftType: f.aircraft,
        isActive: true,
      },
      create: {
        flightNumber: f.flightNumber,
        originCode: f.origin,
        destinationCode: f.dest,
        aircraftType: f.aircraft,
      },
    });

    for (let offset = 1; offset <= DAYS_OUT; offset++) {
      const dep = new Date(today);
      dep.setUTCDate(dep.getUTCDate() + offset);
      // 本地 Asia/Shanghai (UTC+8) → UTC hour = local hour - 8
      dep.setUTCHours(f.departHour - 8, f.departMinute, 0, 0);
      const arr = new Date(dep.getTime() + f.durationMinutes * 60 * 1000);

      const existing = await prisma.flightSchedule.findFirst({
        where: { flightId: flight.id, departureTime: dep },
      });
      if (existing) continue;

      await prisma.flightSchedule.create({
        data: {
          flightId: flight.id,
          departureTime: dep,
          arrivalTime: arr,
          departureTz: 'Asia/Shanghai',
          arrivalTz: 'Asia/Shanghai',
          seatClasses: {
            create: [
              { cabin: CabinClass.ECONOMY, capacity: f.econCapacity, basePrice: f.econPrice },
              { cabin: CabinClass.BUSINESS, capacity: f.bizCapacity, basePrice: f.bizPrice },
            ],
          },
        },
      });
      newSchedules++;
    }
  }

  // eslint-disable-next-line no-console
  console.log('✅ seed 完成', {
    admin: admin.email,
    customer: customer.email,
    '1级代理': agent1User.email,
    '2级代理(父=1级)': agent2User.email,
    '3级代理(父=2级)': agent3User.email,
    航班: FLIGHT_SEED.map((f) => `${f.flightNumber} (${f.origin}→${f.dest})`).join(', '),
    新增班次: newSchedules,
    清理旧航班: removedFlights,
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
