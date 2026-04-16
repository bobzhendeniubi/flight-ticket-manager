/**
 * 开发环境 seed：管理员、多层代理、客户，以及 QH9588/QH9589（澳门↔岘港）两条
 * 自营航班的未来 14 天班次。幂等 — 可重复运行。
 *
 * 航班信息参考 Bamboo Airways 公开时刻表（2026 春夏表）:
 *   QH9588  DAD → MFM  11:40 起飞（DAD GMT+7）→ 14:25 到达（MFM GMT+8）  A321
 *   QH9589  MFM → DAD  15:25 起飞（MFM GMT+8）→ 16:10 到达（DAD GMT+7）  A321
 *
 * Run: npm run prisma:seed  (from backend/)
 */
import { PrismaClient, UserRole, CabinClass } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

// 航班配置：时间都用「出发地本地」表达，下面会按 IANA tz 折算到 UTC。
const FLIGHT_SEED = [
  {
    flightNumber: 'QH9588',
    origin: 'DAD', // 岘港
    dest: 'MFM', // 澳门
    departTz: 'Asia/Ho_Chi_Minh', // GMT+7
    arrivalTz: 'Asia/Macau', // GMT+8
    departHourLocal: 11,
    departMinuteLocal: 40,
    durationMinutes: 105, // 1h 45m
    aircraft: 'Airbus A321-211',
    econCapacity: 180,
    econPrice: 1380,
    bizCapacity: 20,
    bizPrice: 4280,
  },
  {
    flightNumber: 'QH9589',
    origin: 'MFM',
    dest: 'DAD',
    departTz: 'Asia/Macau',
    arrivalTz: 'Asia/Ho_Chi_Minh',
    departHourLocal: 15,
    departMinuteLocal: 25,
    durationMinutes: 105,
    aircraft: 'Airbus A321-211',
    econCapacity: 180,
    econPrice: 1480,
    bizCapacity: 20,
    bizPrice: 4380,
  },
] as const;

const DAYS_OUT = 365;

/** 把"出发地本地时间"转为 UTC Date。只支持整小时偏移（Asia/Ho_Chi_Minh=+7, Asia/Macau=+8）。 */
function localToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const offsetHours = tz === 'Asia/Macau' ? 8 : tz === 'Asia/Ho_Chi_Minh' ? 7 : 8;
  return new Date(Date.UTC(year, month, day, hour - offsetHours, minute, 0));
}

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
      displayName: '1级代理 · 澳门总代',
      emailVerified: true,
    },
  });

  const agent1 = await prisma.agent.upsert({
    where: { userId: agent1User.id },
    update: {},
    create: {
      userId: agent1User.id,
      companyName: '澳门岘港旅游总代',
      contactName: '王总代',
      contactPhone: '+85290000001',
      prepaymentBalance: 80000,
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
      displayName: '2级代理 · 澳门区代',
      emailVerified: true,
    },
  });

  const agent2 = await prisma.agent.upsert({
    where: { userId: agent2User.id },
    update: {},
    create: {
      userId: agent2User.id,
      companyName: '澳门欢乐旅行社',
      contactName: '李区代',
      contactPhone: '+85366000002',
      prepaymentBalance: 20000,
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
      companyName: '澳门威尼斯人门店',
      contactName: '张门店',
      contactPhone: '+85366000003',
      prepaymentBalance: 5000,
      parentAgentId: agent2.id,
      tier: 3,
    },
  });

  // ── 清理不在列表里的历史航班（只在没有订单关联时） ──
  const keepFlightNumbers = FLIGHT_SEED.map((f) => f.flightNumber);
  const toRemove = await prisma.flight.findMany({
    where: { flightNumber: { notIn: keepFlightNumbers } },
    include: { schedules: { include: { orderItems: { take: 1 } } } },
  });
  let removedFlights = 0;
  for (const f of toRemove) {
    const hasOrders = f.schedules.some((s) => s.orderItems.length > 0);
    if (hasOrders) continue;
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

    // 清理当前航班上时区已变更的旧班次（例如 QH 从国内航线改到澳门↔岘港）
    const stale = await prisma.flightSchedule.findMany({
      where: {
        flightId: flight.id,
        OR: [{ departureTz: { not: f.departTz } }, { arrivalTz: { not: f.arrivalTz } }],
      },
      include: { orderItems: { take: 1 } },
    });
    for (const s of stale) {
      if (s.orderItems.length === 0) {
        await prisma.flightSchedule.delete({ where: { id: s.id } });
      }
    }

    // 批量预取已存在的出发时间，避免 365 次 findFirst 往返
    const existingTimes = new Set(
      (
        await prisma.flightSchedule.findMany({
          where: { flightId: flight.id },
          select: { departureTime: true },
        })
      ).map((s) => s.departureTime.getTime()),
    );

    for (let offset = 1; offset <= DAYS_OUT; offset++) {
      const base = new Date(today);
      base.setUTCDate(base.getUTCDate() + offset);
      const y = base.getUTCFullYear();
      const m = base.getUTCMonth();
      const d = base.getUTCDate();

      const dep = localToUtc(y, m, d, f.departHourLocal, f.departMinuteLocal, f.departTz);
      const arr = new Date(dep.getTime() + f.durationMinutes * 60 * 1000);

      if (existingTimes.has(dep.getTime())) continue;

      await prisma.flightSchedule.create({
        data: {
          flightId: flight.id,
          departureTime: dep,
          arrivalTime: arr,
          departureTz: f.departTz,
          arrivalTz: f.arrivalTz,
          seatClasses: {
            create: [
              { cabin: CabinClass.ECONOMY, capacity: f.econCapacity, basePrice: f.econPrice },
              { cabin: CabinClass.BUSINESS, capacity: f.bizCapacity, basePrice: f.bizPrice },
            ],
          },
        },
      });
      newSchedules++;
      if (newSchedules % 100 === 0) {
        // eslint-disable-next-line no-console
        console.log(`  …已创建 ${newSchedules} 个班次`);
      }
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
