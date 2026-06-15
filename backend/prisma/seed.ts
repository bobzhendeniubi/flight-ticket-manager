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
import {
  PrismaClient,
  UserRole,
  CabinClass,
  OrderStatus,
  OrderItemKind,
  PaymentMethod,
  PaymentStatus,
  DocumentType,
  ProductReviewType,
  Prisma,
} from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

/** 随机整数 [min, max]（含两端）。seed 展示数据用，无需密码学随机。 */
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 从数组里随机取一个元素。 */
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

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
  // 再造 2 个散客让 AGENT 视图有数据可看
  const customer2 = await prisma.user.upsert({
    where: { email: 'customer2@ftm.local' },
    update: {},
    create: {
      email: 'customer2@ftm.local',
      passwordHash: hash,
      role: UserRole.CUSTOMER,
      displayName: '张三（代理 A 名下）',
      phone: '+85290000101',
      emailVerified: true,
    },
  });
  const customer3 = await prisma.user.upsert({
    where: { email: 'customer3@ftm.local' },
    update: {},
    create: {
      email: 'customer3@ftm.local',
      passwordHash: hash,
      role: UserRole.CUSTOMER,
      displayName: '李四（代理 A 名下）',
      phone: '+85290000102',
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

  const agent3 = await prisma.agent.upsert({
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

  // ── 更多 demo 代理（扩展树，展示多分支结构）──
  //  agent1 (tier1)
  //   ├── agent2 (tier2)  → agent3 / agent3b
  //   └── agent2b (tier2) → agent3c
  const demoAgents: Array<{
    email: string;
    displayName: string;
    companyName: string;
    contactName: string;
    contactPhone: string;
    prepaymentBalance: number;
    tier: number;
    parentAgentId: string | null;
  }> = [
    // 2 级分支 B — 独立 2 级代理（agent1 的另一下级）
    { email: 'agent2b@ftm.local', displayName: '2级代理 · 分店 B', companyName: '澳门珠江旅行社', contactName: '林经理', contactPhone: '+85366000012', prepaymentBalance: 18000, tier: 2, parentAgentId: agent1.id },
    // 3 级分支 B — agent2 的另一下级
    { email: 'agent3b@ftm.local', displayName: '3级代理 · 新口岸门店', companyName: '澳门新口岸营业部', contactName: '王店长', contactPhone: '+85366000013', prepaymentBalance: 4000, tier: 3, parentAgentId: agent2.id },
    // 3 级分支 C — agent2b 的下级
    { email: 'agent3c@ftm.local', displayName: '3级代理 · 氹仔门店', companyName: '氹仔旅游服务中心', contactName: '陈主任', contactPhone: '+85366000014', prepaymentBalance: 3500, tier: 3, parentAgentId: null /* 填在下方 */ },
  ];

  // 先建 2 级代理，再建 3 级（3 级需要引用 2 级 id）
  const agent2b = await upsertAgent(demoAgents[0]);
  const agent3b = await upsertAgent(demoAgents[1]);
  demoAgents[2].parentAgentId = agent2b.id;
  const agent3c = await upsertAgent(demoAgents[2]);

  // ── CustomerProfile 把演示散客挂到 agent1（让 AGENT 后台有数据）──
  await prisma.customerProfile.upsert({
    where: { userId: customer2.id },
    update: { primaryAgentId: agent1.id },
    create: {
      userId: customer2.id,
      primaryAgentId: agent1.id,
      tags: ['vip'],
      notes: '代理 A 长期合作客户',
    },
  });
  await prisma.customerProfile.upsert({
    where: { userId: customer3.id },
    update: { primaryAgentId: agent2.id },
    create: {
      userId: customer3.id,
      primaryAgentId: agent2.id, // 挂到下级 2A —— 验证 agent1 能看到下级的客户
      tags: ['新客'],
      notes: '代理 2A 门店客户',
    },
  });

  async function upsertAgent(cfg: typeof demoAgents[0]) {
    const u = await prisma.user.upsert({
      where: { email: cfg.email },
      update: {},
      create: {
        email: cfg.email, passwordHash: hash, role: UserRole.AGENT,
        displayName: cfg.displayName, emailVerified: true,
      },
    });
    return prisma.agent.upsert({
      where: { userId: u.id },
      update: {},
      create: {
        userId: u.id,
        companyName: cfg.companyName,
        contactName: cfg.contactName,
        contactPhone: cfg.contactPhone,
        prepaymentBalance: cfg.prepaymentBalance,
        parentAgentId: cfg.parentAgentId,
        tier: cfg.tier,
      },
    });
  }

  // ── CommissionRule 默认费率（按产品类型 + 层级） ──
  // 不变式：child rate ≤ parent rate
  // 1 级 FLIGHT 10% / HOTEL 8% / TRANSFER 15% / VISA 12%
  // 2 级 FLIGHT 6%  / HOTEL 5% / TRANSFER 10% / VISA 8%
  // 3 级 FLIGHT 3%  / HOTEL 3% / TRANSFER 6%  / VISA 5%
  const commissionSeed: Array<{ agentId: string; rates: Record<'FLIGHT'|'HOTEL'|'TRANSFER'|'VISA', number> }> = [
    { agentId: agent1.id,  rates: { FLIGHT: 0.10, HOTEL: 0.08, TRANSFER: 0.15, VISA: 0.12 } },
    { agentId: agent2.id,  rates: { FLIGHT: 0.06, HOTEL: 0.05, TRANSFER: 0.10, VISA: 0.08 } },
    { agentId: agent2b.id, rates: { FLIGHT: 0.06, HOTEL: 0.05, TRANSFER: 0.10, VISA: 0.08 } },
    { agentId: agent3.id,  rates: { FLIGHT: 0.03, HOTEL: 0.03, TRANSFER: 0.06, VISA: 0.05 } },
    { agentId: agent3b.id, rates: { FLIGHT: 0.03, HOTEL: 0.03, TRANSFER: 0.06, VISA: 0.05 } },
    { agentId: agent3c.id, rates: { FLIGHT: 0.03, HOTEL: 0.03, TRANSFER: 0.06, VISA: 0.05 } },
  ];
  for (const { agentId, rates } of commissionSeed) {
    for (const [productKind, rate] of Object.entries(rates)) {
      // effectiveFrom 取固定值（非 now()），避免每次 seed 创建新规则
      const effectiveFrom = new Date('2026-01-01T00:00:00Z');
      await prisma.commissionRule.upsert({
        where: {
          agentId_productKind_effectiveFrom: {
            agentId,
            productKind: productKind as 'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA',
            effectiveFrom,
          },
        },
        update: { rate },
        create: {
          agentId,
          productKind: productKind as 'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA',
          rate,
          effectiveFrom,
        },
      });
    }
  }

  // ── 产品：Hotels / Transfers / Visas / Bundles（upsert 幂等） ──
  await seedHotels();
  await seedTransfers();
  await seedVisas();
  await seedBundles();

  // ── 取消订单费率（默认每个 kind 一条 isDefault 兜底）──
  await seedCancellationPolicies();

  // ── Demo 订单（演示后台用：6 条不同状态的样例订单）──
  await seedDemoOrders(customer.id);

  // ── 上线编造评价（每产品 6~12 条 zh-CN 评价 + 航线评价）──
  await seedReviews();

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

  // ── 日期等级 (DateRanking) — 365 天 ────────────────────────────────
  // DOW 默认：Sun=A, Mon=C, Tue=D, Wed=D, Thu=C, Fri=B, Sat=B
  const DOW_RANK: Record<number, string> = {
    0: 'A', // Sunday
    1: 'C', // Monday
    2: 'D', // Tuesday
    3: 'D', // Wednesday
    4: 'C', // Thursday
    5: 'B', // Friday
    6: 'B', // Saturday
  };
  const DOW_REASON: Record<number, string> = {
    0: 'default:Sunday', 1: 'default:Monday', 2: 'default:Tuesday',
    3: 'default:Wednesday', 4: 'default:Thursday', 5: 'default:Friday', 6: 'default:Saturday',
  };

  // 2026 中国节假日 (近似)
  const HOLIDAYS_2026: Array<{ start: string; end: string; name: string }> = [
    { start: '2026-01-26', end: '2026-02-01', name: '春节' },
    { start: '2026-04-04', end: '2026-04-06', name: '清明' },
    { start: '2026-05-01', end: '2026-05-05', name: '五一' },
    { start: '2026-05-31', end: '2026-05-31', name: '端午' },
    { start: '2026-10-01', end: '2026-10-07', name: '国庆' },
    { start: '2026-10-06', end: '2026-10-06', name: '中秋' },
    { start: '2026-07-01', end: '2026-08-31', name: '暑期旺季' }, // rank B
    { start: '2026-12-24', end: '2027-01-02', name: '圣诞/元旦' },
  ];

  // 构建 holiday lookup
  const holidayMap = new Map<string, { name: string; rank: string }>();
  for (const h of HOLIDAYS_2026) {
    const s = new Date(h.start);
    const e = new Date(h.end);
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      // 暑期旺季 = B，其他节假日 = A
      const rank = h.name === '暑期旺季' ? 'B' : 'A';
      // 节假日覆盖暑期
      if (!holidayMap.has(key) || rank === 'A') {
        holidayMap.set(key, { name: h.name, rank });
      }
    }
  }

  // 批量预取已存在的 DateRanking
  const existingDates = new Set(
    (await prisma.dateRanking.findMany({ select: { date: true } })).map(
      (r) => r.date.toISOString().slice(0, 10),
    ),
  );

  let newRankings = 0;
  for (let offset = 0; offset < 365; offset++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + offset);
    const key = d.toISOString().slice(0, 10);
    if (existingDates.has(key)) continue;

    const holiday = holidayMap.get(key);
    const dow = d.getUTCDay();
    const rank = holiday?.rank ?? DOW_RANK[dow];
    const reason = holiday?.name ?? DOW_REASON[dow];

    await prisma.dateRanking.create({
      data: {
        date: d,
        rank,
        reason,
        isManual: false,
      },
    });
    newRankings++;
    if (newRankings % 100 === 0) {
      // eslint-disable-next-line no-console
      console.log(`  …已创建 ${newRankings} 个日期等级`);
    }
  }

  // eslint-disable-next-line no-console
  console.log('✅ seed 完成', {
    admin: admin.email,
    customer: customer.email,
    '1级代理': agent1User.email,
    '2级代理 A (父=1级)': agent2User.email,
    '2级代理 B (父=1级)': 'agent2b@ftm.local',
    '3级代理 A (父=2A)': agent3User.email,
    '3级代理 B (父=2A)': 'agent3b@ftm.local',
    '3级代理 C (父=2B)': 'agent3c@ftm.local',
    航班: FLIGHT_SEED.map((f) => `${f.flightNumber} (${f.origin}→${f.dest})`).join(', '),
    新增班次: newSchedules,
    新增日期等级: newRankings,
    清理旧航班: removedFlights,
    开发密码: password,
  });
}

// ════════════════════════════════════════════════════════════════════
// 产品 seed helpers
// ════════════════════════════════════════════════════════════════════
async function seedHotels() {
  const ROOM_TYPES = [
    { name: '豪华双床房', bedType: '2 张单人床', mult: 1.0, capacity: 2 },
    { name: '海景大床房', bedType: '1 张大床 · 海景', mult: 1.15, capacity: 2 },
    { name: '行政套房', bedType: '1 张大床 + 客厅', mult: 1.45, capacity: 3 },
    { name: '别墅套房', bedType: '2 卧室 + 私人泳池', mult: 1.85, capacity: 4 },
  ];
  const HOTELS = [
    { key: 'h1', name: '岘港四季度假村', nameEn: 'Four Seasons Resort The Nam Hai', cityCode: 'DAD', area: '美溪海滩 / 会安之间', address: 'Hamlet 1, Dien Duong, Dien Ban, Quang Nam', stars: 5, basePrice: 3280, rating: 4.9, reviewCount: 2891, emoji: '🏝️', photo: 'https://images.unsplash.com/photo-1582719508461-905c673771fd?w=600&h=400&fit=crop', gallery: ['https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?w=600&h=400&fit=crop', 'https://images.unsplash.com/photo-1611892440504-42a792e24d32?w=600&h=400&fit=crop'], amenities: ['私人海滩', '全海景别墅', '3 个无边泳池', '含自助早餐', '免费班车', 'SPA'], highlight: '全别墅式私密度假，The Nam Hai 独家 1km 海岸线' },
    { key: 'h2', name: '岘港洲际半岛度假村', nameEn: 'InterContinental Danang Sun Peninsula Resort', cityCode: 'DAD', area: '山茶半岛', address: 'Bai Bac, Son Tra Peninsula, Danang', stars: 5, basePrice: 3680, rating: 4.9, reviewCount: 3421, emoji: '🌊', photo: 'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=600&h=400&fit=crop', gallery: ['https://images.unsplash.com/photo-1455587734955-081b22074882?w=600&h=400&fit=crop', 'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=600&h=400&fit=crop'], amenities: ['私人海湾', '缆车', '米其林餐厅 La Maison 1888', '日落无敌海景', '豪华 SPA'], highlight: 'Bill Bensley 设计，山茶半岛独占海湾' },
    { key: 'h3', name: '岘港凯悦度假村', nameEn: 'Hyatt Regency Danang Resort and Spa', cityCode: 'DAD', area: '美溪海滩', address: '5 Truong Sa Street, Hoa Hai Ward, Danang', stars: 5, basePrice: 1880, rating: 4.7, reviewCount: 4215, emoji: '🏖️', photo: 'https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=600&h=400&fit=crop', gallery: ['https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=600&h=400&fit=crop', 'https://images.unsplash.com/photo-1571902943202-507ec2618e8f?w=600&h=400&fit=crop'], amenities: ['5 个泳池', '直通海滩', '儿童俱乐部', '含早餐', '免费机场班车'], highlight: '美溪海滩热门家庭首选，亲子设施完善' },
    { key: 'h4', name: '岘港铂尔曼海滩度假村', nameEn: 'Pullman Danang Beach Resort', cityCode: 'DAD', area: '美溪海滩', address: '101 Vo Nguyen Giap, Danang', stars: 5, basePrice: 1480, rating: 4.6, reviewCount: 2108, emoji: '🏨', photo: 'https://images.unsplash.com/photo-1445019980597-93fa8acb246c?w=600&h=400&fit=crop', gallery: ['https://images.unsplash.com/photo-1551882547-ff40c63fe5fa?w=600&h=400&fit=crop', 'https://images.unsplash.com/photo-1610641818989-c2051b5e2cfd?w=600&h=400&fit=crop'], amenities: ['海滩泳池', '水疗中心', '含早餐', '儿童乐园'], highlight: '性价比首选，美溪海滩中心位置' },
    { key: 'h5', name: '会安阿南塔拉度假村', nameEn: 'Anantara Hoi An Resort', cityCode: 'HOA', area: '会安古城', address: '1 Pham Hong Thai, Hoi An', stars: 5, basePrice: 2280, rating: 4.8, reviewCount: 1892, emoji: '🏮', photo: 'https://images.unsplash.com/photo-1578662996442-48f60103fc96?w=600&h=400&fit=crop', gallery: ['https://images.unsplash.com/photo-1582610116397-edb318620f90?w=600&h=400&fit=crop', 'https://images.unsplash.com/photo-1568084680786-a84f91d1153c?w=600&h=400&fit=crop'], amenities: ['河畔泳池', '古城步行 5 分钟', '越南传统建筑', 'SPA'], highlight: '会安古城中心，步行即达灯笼市集' },
  ];

  for (const h of HOTELS) {
    // 用 (name, cityCode) 当 upsert key 的替身（schema 没有 unique，所以先查再 upsert）
    const existing = await prisma.hotel.findFirst({ where: { name: h.name, cityCode: h.cityCode } });
    const rooms = ROOM_TYPES.map((rt) => ({
      name: rt.name,
      bedType: rt.bedType,
      capacity: rt.capacity,
      basePrice: h.basePrice * rt.mult,
      priceMultiplier: rt.mult,
    }));
    const soldCount = randInt(120, 980); // 已售份数（展示用）
    if (existing) {
      await prisma.hotel.update({
        where: { id: existing.id },
        data: {
          nameEn: h.nameEn, area: h.area, address: h.address, starRating: h.stars,
          basePrice: h.basePrice, rating: h.rating, reviewCount: h.reviewCount, soldCount,
          emoji: h.emoji, photos: [h.photo, ...h.gallery], amenities: h.amenities, highlight: h.highlight, isActive: true,
        },
      });
      // 房型先删再建
      await prisma.hotelRoomType.deleteMany({ where: { hotelId: existing.id } });
      await prisma.hotelRoomType.createMany({
        data: rooms.map((r) => ({ hotelId: existing.id, ...r })),
      });
    } else {
      await prisma.hotel.create({
        data: {
          name: h.name, nameEn: h.nameEn, cityCode: h.cityCode, area: h.area, address: h.address,
          starRating: h.stars, basePrice: h.basePrice, rating: h.rating, reviewCount: h.reviewCount, soldCount,
          emoji: h.emoji, photos: [h.photo, ...h.gallery], amenities: h.amenities, highlight: h.highlight, isActive: true,
          roomTypes: { create: rooms },
        },
      });
    }
  }
}

async function seedTransfers() {
  const TRANSFERS = [
    { name: '岘港机场接送 · 经济轿车', vehicleType: '舒适型轿车（4 座）', capacity: 3, basePrice: 98, originArea: '岘港机场 (DAD)', destArea: '美溪海滩 / 市区任一酒店', emoji: '🚗', photo: 'https://images.unsplash.com/photo-1502877338535-766e1452684a?w=600&h=400&fit=crop', features: ['含中文司机', '免费等候 60 分钟', '含儿童安全座椅', '矿泉水'], duration: '约 15 分钟' },
    { name: '岘港机场接送 · 7 座商务车', vehicleType: '7 座 MPV（如丰田 Innova）', capacity: 6, basePrice: 188, originArea: '岘港机场 (DAD)', destArea: '美溪海滩 / 山茶半岛 / 市区', emoji: '🚐', photo: 'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?w=600&h=400&fit=crop', features: ['家庭首选', '6 大件行李空间', '中文司机', '免费等候 60 分钟'], duration: '约 15–30 分钟' },
    { name: '岘港 → 会安古城 专车', vehicleType: '舒适型轿车 / 商务车', capacity: 6, basePrice: 248, originArea: '岘港酒店', destArea: '会安古城', emoji: '🏮', photo: 'https://images.unsplash.com/photo-1519641471654-76ce0107ad1b?w=600&h=400&fit=crop', features: ['单程约 45 分钟', '可中途停美溪海滩拍照', '含中文司机'], duration: '约 45 分钟' },
    { name: '巴拿山 1 日包车', vehicleType: '7 座商务车', capacity: 6, basePrice: 588, originArea: '岘港酒店', destArea: '巴拿山法国小镇 + 佛手黄金桥', emoji: '🌉', photo: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=600&h=400&fit=crop', features: ['8 小时包车', '含门票预订代购', '含中文司机', '可加购法式小镇午餐'], duration: '单程约 40 分钟' },
    { name: '岘港 → 顺化故都 1 日游包车', vehicleType: '7 座商务车', capacity: 6, basePrice: 888, originArea: '岘港酒店', destArea: '海云岭 → 顺化皇城 → 返回', emoji: '🏯', photo: 'https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?w=600&h=400&fit=crop', features: ['途经海云岭观景台', '包含顺化景点解说', '10 小时包车', '中文司机'], duration: '全程约 10 小时' },
    { name: '岘港 → 美山圣地 半日包车', vehicleType: '舒适型轿车 / 商务车', capacity: 6, basePrice: 488, originArea: '岘港酒店', destArea: '美山遗址（UNESCO）→ 返回', emoji: '🛕', photo: 'https://images.unsplash.com/photo-1545569341-9eb8b30979d9?w=600&h=400&fit=crop', features: ['UNESCO 占婆遗址', '5 小时包车', '中文司机', '含矿泉水'], duration: '约 5 小时' },
  ];

  for (const t of TRANSFERS) {
    const soldCount = randInt(80, 640);
    const existing = await prisma.transfer.findFirst({ where: { name: t.name } });
    if (existing) {
      await prisma.transfer.update({ where: { id: existing.id }, data: { ...t, basePrice: t.basePrice, soldCount, isActive: true } });
    } else {
      await prisma.transfer.create({ data: { ...t, soldCount, isActive: true } });
    }
  }
}

async function seedVisas() {
  const VISAS = [
    { destinationCountry: 'VN', country: '越南', flag: '🇻🇳', photo: 'https://images.unsplash.com/photo-1559592413-7cec4d0cae2b?w=600&h=400&fit=crop', visaType: 'e_visa', visaName: '电子签证 E-visa · 30 天单次', processingDays: 3, basePrice: 280, expressSurcharge: 150, validityMonths: 1, highlight: '最热销 · 全流程线上', requiredDocs: ['护照首页扫描件', '2 寸白底照片电子版'] },
    { destinationCountry: 'VN', country: '越南', flag: '🇻🇳', photo: 'https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=600&h=400&fit=crop', visaType: 'e_visa_90d', visaName: '电子签证 E-visa · 90 天多次', processingDays: 5, basePrice: 680, expressSurcharge: 300, validityMonths: 3, highlight: '适合多次往返商务旅客', requiredDocs: ['护照首页扫描件', '2 寸白底照片电子版', '行程单'] },
    { destinationCountry: 'VN', country: '越南', flag: '🇻🇳', photo: 'https://images.unsplash.com/photo-1583417319070-4a69db38a482?w=600&h=400&fit=crop', visaType: 'visa_on_arrival', visaName: '落地签批文', processingDays: 2, basePrice: 180, expressSurcharge: 80, validityMonths: 1, highlight: '最快办理，适合临时出行', requiredDocs: ['护照首页扫描件'] },
    { destinationCountry: 'VN', country: '越南', flag: '🇻🇳', photo: 'https://images.unsplash.com/photo-1528127269322-539801943592?w=600&h=400&fit=crop', visaType: 'business_1y', visaName: '商务邀请函签证（1 年多次）', processingDays: 10, basePrice: 980, expressSurcharge: 500, validityMonths: 12, highlight: '需我方协助发邀请函', requiredDocs: ['护照首页扫描件', '照片', '在职证明', '越南公司邀请函'] },
    { destinationCountry: 'KH', country: '柬埔寨', flag: '🇰🇭', photo: 'https://images.unsplash.com/photo-1563492065599-3520f775eeed?w=600&h=400&fit=crop', visaType: 'e_visa', visaName: '电子签证 E-visa', processingDays: 3, basePrice: 320, expressSurcharge: 120, validityMonths: 3, requiredDocs: ['护照扫描件', '照片'] },
    { destinationCountry: 'TH', country: '泰国', flag: '🇹🇭', photo: 'https://images.unsplash.com/photo-1508009603885-50cf7c579365?w=600&h=400&fit=crop', visaType: 'tourist', visaName: '单次旅游签证', processingDays: 5, basePrice: 280, expressSurcharge: 150, validityMonths: 3, requiredDocs: ['护照原件', '2 寸白底照片', '身份证复印件', '在职证明'] },
  ];

  for (const v of VISAS) {
    const soldCount = randInt(150, 1200);
    const existing = await prisma.visa.findFirst({
      where: { destinationCountry: v.destinationCountry, visaType: v.visaType },
    });
    if (existing) {
      await prisma.visa.update({ where: { id: existing.id }, data: { ...v, soldCount, isActive: true } });
    } else {
      await prisma.visa.create({ data: { ...v, soldCount, isActive: true } });
    }
  }
}

async function seedBundles() {
  const BUNDLES = [
    {
      name: '经典度假 3 晚 · 凯悦海景',
      tagline: '来回机票 + 凯悦海景 3 晚 + 来回接送',
      emoji: '🏖️',
      photo: 'https://images.unsplash.com/photo-1540541338287-41700207dee6?w=600&h=400&fit=crop',
      flightPax: 2,
      groundDiscount: 380,
      suitableFor: '2 人 · 情侣/家庭',
      // 可选升级加价（按产品可配置；运营在后台可改）：单人入住房差/晚、升舱商务/航段、来回 2 段
      singleSupplementCnyPerNight: 80, // 平价 4-5 星，赵姐默认
      businessUpgradeCnyPerLeg: 700,
      legs: 2,
      items: [
        { kind: 'FLIGHT', productName: 'QH 澳门↔岘港 来回经济舱 × 2 人', qty: 1, unitPrice: 0 },
        { kind: 'HOTEL', productName: '岘港凯悦度假村 美溪海景房 3 晚', qty: 3, unitPrice: 1880 },
        { kind: 'TRANSFER', productName: '岘港机场接送（来回 7 座商务车）', qty: 2, unitPrice: 188 },
      ],
    },
    {
      name: '蜜月豪华 4 晚 · 洲际半岛',
      tagline: '来回机票 + 洲际半岛 + 巴拿山佛手桥 + 签证全包',
      emoji: '💍',
      photo: 'https://images.unsplash.com/photo-1564501049412-61c2a3083791?w=600&h=400&fit=crop',
      flightPax: 2,
      groundDiscount: 1200,
      suitableFor: '2 人 · 蜜月/纪念日',
      // 顶级 5 星（洲际半岛）单人入住房差远高于平价默认——一间客房卖一个人，¥80/晚会亏本，故上调
      singleSupplementCnyPerNight: 480,
      businessUpgradeCnyPerLeg: 700,
      legs: 2,
      items: [
        { kind: 'FLIGHT', productName: 'QH 澳门↔岘港 来回经济舱 × 2 人', qty: 1, unitPrice: 0 },
        { kind: 'HOTEL', productName: '岘港洲际半岛度假村 山景房 4 晚', qty: 4, unitPrice: 3680 },
        { kind: 'TRANSFER', productName: '岘港机场接送（豪华轿车 来回）', qty: 2, unitPrice: 388 },
        { kind: 'TRANSFER', productName: '巴拿山 1 日包车', qty: 1, unitPrice: 588 },
        { kind: 'VISA', productName: '越南 E-visa 30 天 × 2', qty: 2, unitPrice: 280 },
      ],
    },
    {
      name: '商务快闪 1 晚 · 商务舱',
      tagline: '商务舱来回 + 市区公寓 + 签证 + 豪华接送',
      emoji: '💼',
      photo: 'https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?w=600&h=400&fit=crop',
      flightPax: 1,
      groundDiscount: 200,
      suitableFor: '1 人 · 商务',
      // 单人产品 + 市区公寓：单人入住房差适中；本套餐机票已是商务舱，升舱项给默认即可
      singleSupplementCnyPerNight: 150,
      businessUpgradeCnyPerLeg: 700,
      legs: 2,
      items: [
        { kind: 'FLIGHT', productName: 'QH 澳门↔岘港 来回商务舱 × 1 人', qty: 1, unitPrice: 0 },
        { kind: 'HOTEL', productName: '馨乐庭蓝湾公寓 市区 1 晚', qty: 1, unitPrice: 580 },
        { kind: 'TRANSFER', productName: '岘港机场接送（豪华轿车 来回）', qty: 2, unitPrice: 388 },
        { kind: 'VISA', productName: '越南落地签批文', qty: 1, unitPrice: 180 },
      ],
    },
  ];

  for (const b of BUNDLES) {
    const soldCount = randInt(60, 520);
    const existing = await prisma.bundle.findFirst({ where: { name: b.name } });
    if (existing) {
      await prisma.bundle.update({
        where: { id: existing.id },
        data: { ...b, items: b.items, soldCount, isActive: true },
      });
    } else {
      await prisma.bundle.create({ data: { ...b, items: b.items, soldCount, isActive: true } });
    }
  }
}

async function seedCancellationPolicies() {
  // 业界常见的退订手续费阶梯
  // hoursBeforeDeparture = -1 表示"已起飞 / 已入住 / 已履约" — 100%
  const POLICIES = [
    {
      productKind: 'FLIGHT' as const,
      name: '默认机票退订规则',
      tiers: [
        { hoursBeforeDeparture: 168, feePercent: 5 },   // 7+ 天
        { hoursBeforeDeparture: 72,  feePercent: 20 },  // 3-7 天
        { hoursBeforeDeparture: 24,  feePercent: 50 },  // 1-3 天
        { hoursBeforeDeparture: 0,   feePercent: 80 },  // < 24 h
        { hoursBeforeDeparture: -1,  feePercent: 100 }, // 已起飞
      ],
      notes: '可在后台「取消政策」页修改',
    },
    {
      productKind: 'HOTEL' as const,
      name: '默认酒店退订规则',
      tiers: [
        { hoursBeforeDeparture: 72, feePercent: 0 },    // 3+ 天免费
        { hoursBeforeDeparture: 24, feePercent: 50 },   // 24-72h 收首晚 50%
        { hoursBeforeDeparture: 0,  feePercent: 100 },  // < 24h 全额
        { hoursBeforeDeparture: -1, feePercent: 100 },  // 已入住
      ],
    },
    {
      productKind: 'TRANSFER' as const,
      name: '默认接送退订规则',
      tiers: [
        { hoursBeforeDeparture: 24, feePercent: 0 },    // 24+ 小时免费
        { hoursBeforeDeparture: 6,  feePercent: 30 },   // 6-24h 30%
        { hoursBeforeDeparture: 0,  feePercent: 80 },   // < 6h 80%
        { hoursBeforeDeparture: -1, feePercent: 100 },
      ],
    },
    {
      productKind: 'VISA' as const,
      name: '默认签证退订规则',
      tiers: [
        // 签证一旦提交使馆就基本无法退；这里以"是否已提交"作为分界
        { hoursBeforeDeparture: 9999, feePercent: 50 }, // 提交前（demo: 大数字代表未提交）
        { hoursBeforeDeparture: -1,   feePercent: 100 }, // 已提交使馆
      ],
      notes: 'Visa 比较特殊：实际应根据使馆受理状态算费率',
    },
    {
      productKind: 'BUNDLE' as const,
      name: '默认套餐退订规则',
      tiers: [
        { hoursBeforeDeparture: 168, feePercent: 10 },
        { hoursBeforeDeparture: 72,  feePercent: 30 },
        { hoursBeforeDeparture: 24,  feePercent: 60 },
        { hoursBeforeDeparture: 0,   feePercent: 90 },
        { hoursBeforeDeparture: -1,  feePercent: 100 },
      ],
    },
  ];

  for (const p of POLICIES) {
    await prisma.cancellationPolicy.upsert({
      where: { productKind_scope: { productKind: p.productKind, scope: '__DEFAULT__' } },
      update: {
        name: p.name,
        tiers: p.tiers,
        isDefault: true,
        isActive: true,
        notes: p.notes ?? null,
      },
      create: {
        productKind: p.productKind,
        scope: '__DEFAULT__', // 占位，避免 unique([kind, null]) 在 Prisma 里不生效
        name: p.name,
        tiers: p.tiers,
        isDefault: true,
        isActive: true,
        notes: p.notes ?? null,
      },
    });
  }
}

// ════════════════════════════════════════════════════════════════════════
// SEED: fabricated launch reviews — replace with real ones
// ────────────────────────────────────────────────────────────────────────
// 上线冷启动用的「编造」评价：澳门⇌岘港海岛游主题、zh-CN、4~5 星为主偶尔 3 星，
// 作者名脱敏（王**/陈*/L** 等），createdAt 散布在最近 ~6 个月，tripType 混合。
// 每个 BUNDLE/HOTEL/TRANSFER/VISA 产品各 6~12 条；几条航线评价。
// 删除方式：整段（本注释到下方对应 END 标记）连同 seedReviews() 调用一并删除即可。
// ════════════════════════════════════════════════════════════════════════

// 脱敏作者名池（姓打码，保留名/首字母风格）
const FAKE_AUTHORS = [
  '王**', '陈*', '李**', '张*', '刘**', '黄*', '吴**', '周*', '徐**', '林*',
  'L**', 'W**', 'Z**', 'C**', '赵*', '孙**', '马*', '朱**', '胡*', '郭**',
] as const;

const TRIP_TYPES = ['家庭', '情侣', '朋友', '商务'] as const;

// 各品类评价正文池（真实口吻，围绕澳门⇌岘港海岛游）
const REVIEW_BODIES: Record<ProductReviewType, readonly { title?: string; body: string }[]> = {
  BUNDLE: [
    { title: '省心又划算', body: '机票酒店接送一次搞定，比自己单订便宜不少，全程不用操心，岘港海景真的绝。' },
    { title: '蜜月首选', body: '套餐里洲际半岛太惊艳了，日落海景配米其林晚餐，客服安排得很周到，强烈推荐。' },
    { body: '一家四口出行，凯悦套餐性价比高，亲子设施齐全，接送司机准时还会说中文。' },
    { body: '套餐价格透明没有隐形消费，行程紧凑但很顺，巴拿山佛手桥那天玩得很尽兴。' },
    { body: '第二次买他们家套餐了，签证机票酒店全包，省去自己研究的时间，老客户认证。' },
    { body: '整体满意，唯一小遗憾是回程航班偏早，但套餐本身很超值，会再来。' },
    { body: '朋友几个人拼的套餐，分房安排很合理，客服沟通响应快，玩得很开心。' },
    { title: '商务出行也合适', body: '商务舱+市区公寓的快闪套餐很适合短差，落地签批文办得很快，效率高。' },
    { body: '海景房升级加了点钱很值，套餐含的接送省了打车的麻烦，下次还选这家。' },
    { body: '岘港的海太干净了，套餐安排的会安一日游也很有味道，灯笼夜景拍照很美。' },
  ],
  HOTEL: [
    { title: '海景无敌', body: '房间正对大海，早上拉开窗帘就是无边泳池和海平线，服务也很贴心。' },
    { body: '床很舒服，自助早餐种类多，离海滩很近，性价比在五星里算高的。' },
    { title: '设施很新', body: '泳池干净，健身房设备齐全，前台有会中文的同事，沟通无障碍。' },
    { body: '位置很好，去市区和海滩都方便，房间隔音不错，睡得很安稳。' },
    { body: '带孩子住的家庭房很宽敞，儿童俱乐部小朋友玩得不想走，会再来。' },
    { body: '度假村环境一流，绿化好空气清新，唯一就是餐厅价格略高，可以出去吃。' },
    { title: '性价比之选', body: '虽然不是顶奢但干净舒适，海滩私密度高，这个价格很满意。' },
    { body: 'SPA 体验很棒，按摩师手法专业，泡完池子再来一场，整个人都放松了。' },
    { body: '房间打扫及时，毛巾每天换，细节到位，下次去岘港还住这里。' },
  ],
  TRANSFER: [
    { title: '司机准时', body: '航班落地就看到举牌的司机，全程开车很稳，还帮忙搬行李，体验好。' },
    { body: '中文司机沟通顺畅，路上还介绍了几个当地吃饭的地方，很热情。' },
    { body: '车很干净有矿泉水，儿童安全座椅也提前备好了，带娃出行放心。' },
    { title: '包车很值', body: '巴拿山一日包车，司机等了我们一整天毫无怨言，行程自由度高。' },
    { body: '7 座商务车空间大，一家人加行李完全够，价格也比打表便宜。' },
    { body: '去会安古城的专车很准时，中途还停美溪海滩让我们拍照，加分。' },
    { body: '深夜航班也安排到了接机，司机一直在等，很负责，推荐。' },
    { body: '顺化一日游包车体验不错，海云岭观景台风景太美了，司机很会找角度。' },
  ],
  VISA: [
    { title: '出签很快', body: '资料交上去三天就出签了，全程线上不用跑，比想象中省心太多。' },
    { body: '客服很耐心，照片不合格还提醒我重拍，最后顺利拿到电子签。' },
    { body: '加急服务很给力，临出发前两天才办，居然也赶上了，救命。' },
    { title: '省心代办', body: '第一次办越南签证，跟着指引一步步来，没踩坑，已推荐给同事。' },
    { body: '价格透明，出签邮件直接发到邮箱，打印带着就能过关，方便。' },
    { body: '90 天多次往返签很适合我经常出差，办理流程清晰，效率高。' },
    { body: '落地签批文当天就发来了，临时决定的行程也不慌，靠谱。' },
  ],
  FLIGHT: [
    { title: '准点舒适', body: '澳门飞岘港很准时，机舱干净，乘务态度好，一个多小时就到了。' },
    { body: '直飞省时间，行李额度够用，整体体验不错，回程也顺利。' },
    { body: '经济舱座位间距还可以，短途航线性价比高，会再选。' },
    { body: '值机顺畅，起降平稳，澳门⇌岘港这条线很方便周末出游。' },
    { body: '航班整体满意，就是出发那天稍微延误了十几分钟，可以接受。' },
  ],
};

async function seedReviews() {
  const sixMonthsMs = 1000 * 60 * 60 * 24 * 30 * 6;
  const now = Date.now();
  const randCreatedAt = () => new Date(now - randInt(0, sixMonthsMs));
  // 4~5 星为主，偶尔 3 星（权重池）
  const ratingPool = [5, 5, 5, 5, 5, 4, 4, 4, 4, 3] as const;

  type ReviewSeed = { productType: ProductReviewType; productId: string };

  // 收集所有产品的 (type, productId)
  const targets: ReviewSeed[] = [];
  // BUNDLE / TRANSFER / VISA：productId = 自身 id
  const [bundles, transfers, visas] = await Promise.all([
    prisma.bundle.findMany({ select: { id: true } }),
    prisma.transfer.findMany({ select: { id: true } }),
    prisma.visa.findMany({ select: { id: true } }),
  ]);
  bundles.forEach((b) => targets.push({ productType: ProductReviewType.BUNDLE, productId: b.id }));
  transfers.forEach((t) => targets.push({ productType: ProductReviewType.TRANSFER, productId: t.id }));
  visas.forEach((v) => targets.push({ productType: ProductReviewType.VISA, productId: v.id }));
  // HOTEL：productId = hotelRoomType.id（与 products.service 聚合口径一致）
  const roomTypes = await prisma.hotelRoomType.findMany({ select: { id: true } });
  roomTypes.forEach((rt) => targets.push({ productType: ProductReviewType.HOTEL, productId: rt.id }));
  // FLIGHT：productId = flightSchedule.id（几条航线评价，取前若干班次）
  const schedules = await prisma.flightSchedule.findMany({ select: { id: true }, take: 6 });
  schedules.forEach((s) => targets.push({ productType: ProductReviewType.FLIGHT, productId: s.id }));

  // 幂等：已存在该 (type, productId) 的评价就跳过，避免重复 seed 暴涨
  let created = 0;
  let skipped = 0;
  for (const t of targets) {
    const existing = await prisma.review.count({
      where: { productType: t.productType, productId: t.productId },
    });
    if (existing > 0) {
      skipped++;
      continue;
    }
    const pool = REVIEW_BODIES[t.productType];
    const n = randInt(6, Math.min(12, pool.length));
    // 不重复取 n 条正文（pool 不足则允许重复）
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const rows = Array.from({ length: n }, (_, i) => {
      const content = shuffled[i % shuffled.length];
      return {
        productType: t.productType,
        productId: t.productId,
        rating: pick(ratingPool),
        title: content.title ?? null,
        body: content.body,
        authorName: pick(FAKE_AUTHORS),
        verified: Math.random() < 0.8, // 多数标记为来自真实订单
        tripType: pick(TRIP_TYPES),
        createdAt: randCreatedAt(),
      };
    });
    await prisma.review.createMany({ data: rows });
    created += rows.length;
  }
  // eslint-disable-next-line no-console
  console.log(`  …评价（编造）：新增 ${created} 条，跳过 ${skipped} 个已有产品`);
}
// ════════════════════════════════════════════════════════════════════════
// END SEED: fabricated launch reviews
// ════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
// Demo 订单 seed（让客服后台一打开就有数据）
// 6 条不同状态：PAID / TICKETED / COMPLETED / REFUND_REQUESTED / CANCELLED / PENDING_PAYMENT
// 全部用 customer@ftm.local，FLIGHT items 指 QH9588/QH9589 现成班次
// 幂等：orderNumber 已存在就跳过
// ════════════════════════════════════════════════════════════════════
async function seedDemoOrders(customerId: string) {
  // 找未来一周内 + 上周内的班次（pat trip 用 past schedule，未来订单用 future）
  const now = new Date();
  const futureSchedules = await prisma.flightSchedule.findMany({
    where: { departureTime: { gt: now }, isActive: true },
    include: { flight: true, seatClasses: true },
    orderBy: { departureTime: 'asc' },
    take: 30,
  });
  const pastSchedules = await prisma.flightSchedule.findMany({
    where: { departureTime: { lt: now } },
    include: { flight: true, seatClasses: true },
    orderBy: { departureTime: 'desc' },
    take: 5,
  });

  if (futureSchedules.length === 0) {
    // eslint-disable-next-line no-console
    console.log('  ⚠️  没找到未来班次，跳过 demo orders');
    return;
  }

  // 找去程 + 回程一对（同一天附近）
  const goSchedule = futureSchedules.find((s) => s.flight.flightNumber === 'QH9589');
  const retSchedule = futureSchedules.find((s) => s.flight.flightNumber === 'QH9588');
  if (!goSchedule || !retSchedule) {
    // eslint-disable-next-line no-console
    console.log('  ⚠️  缺去程或回程班次，跳过 demo orders');
    return;
  }

  const econ = goSchedule.seatClasses.find((c) => c.cabin === CabinClass.ECONOMY);
  if (!econ) return;
  const econPrice = Number(econ.basePrice);

  // 通用乘客 fixture
  const PASSENGER_LIU = {
    fullName: 'LIU CHAO',
    documentType: DocumentType.PASSPORT,
    documentNumber: 'EE1412098',
    nationality: 'CN',
    dateOfBirth: new Date('1991-01-19'),
  };
  const PASSENGER_WANG = {
    fullName: 'WANG MEI',
    documentType: DocumentType.PASSPORT,
    documentNumber: 'EH8765432',
    nationality: 'CN',
    dateOfBirth: new Date('1993-05-22'),
  };

  const DEMO_ORDERS: Array<{
    orderNumber: string;
    status: OrderStatus;
    paid: boolean; // 是否生成已支付的 Payment 行
    pax: number;
    schedules: typeof futureSchedules; // 关联航班（去程、可选回程）
    note: string;
    createdDaysAgo?: number; // 假装多少天前下单
  }> = [
    {
      orderNumber: 'DEMO-001',
      status: OrderStatus.PAID,
      paid: true,
      pax: 2,
      schedules: [goSchedule, retSchedule],
      note: '已支付待出票（往返 2 人）',
      createdDaysAgo: 1,
    },
    {
      orderNumber: 'DEMO-002',
      status: OrderStatus.TICKETED,
      paid: true,
      pax: 1,
      schedules: [goSchedule],
      note: '已出票（单程）',
      createdDaysAgo: 3,
    },
    {
      orderNumber: 'DEMO-003',
      status: OrderStatus.COMPLETED,
      paid: true,
      pax: 2,
      schedules: pastSchedules.length > 0 ? [pastSchedules[0]] : [goSchedule],
      note: '已完成（past trip）',
      createdDaysAgo: 14,
    },
    {
      orderNumber: 'DEMO-004',
      status: OrderStatus.REFUND_REQUESTED,
      paid: true,
      pax: 1,
      schedules: [goSchedule, retSchedule],
      note: '退款审核中（客户申请取消）',
      createdDaysAgo: 2,
    },
    {
      orderNumber: 'DEMO-005',
      status: OrderStatus.CANCELLED,
      paid: false,
      pax: 1,
      schedules: [goSchedule],
      note: '已取消（未支付超时）',
      createdDaysAgo: 5,
    },
    {
      orderNumber: 'DEMO-006',
      status: OrderStatus.PENDING_PAYMENT,
      paid: false,
      pax: 2,
      schedules: [goSchedule, retSchedule],
      note: '待支付（刚下单 5 分钟内）',
      createdDaysAgo: 0,
    },
  ];

  let created = 0;
  let skipped = 0;
  for (const d of DEMO_ORDERS) {
    const existing = await prisma.order.findUnique({ where: { orderNumber: d.orderNumber } });
    if (existing) {
      skipped++;
      continue;
    }

    const itemsTotal = d.schedules.length * d.pax * econPrice;
    const subtotal = new Prisma.Decimal(itemsTotal);
    const total = subtotal;
    const paidAmount = d.paid ? total : new Prisma.Decimal(0);
    const createdAt = new Date(now.getTime() - (d.createdDaysAgo ?? 0) * 86400_000);

    await prisma.order.create({
      data: {
        orderNumber: d.orderNumber,
        userId: customerId,
        status: d.status,
        currency: 'CNY',
        subtotal,
        taxesAndFees: new Prisma.Decimal(0),
        discountTotal: new Prisma.Decimal(0),
        total,
        paidAmount,
        prepaymentOffset: new Prisma.Decimal(0),
        contactName: '演示客户',
        contactPhone: '13800138000',
        contactEmail: 'customer@ftm.local',
        notes: `Demo 订单 — ${d.note}`,
        createdAt,
        updatedAt: createdAt,
        items: {
          create: d.schedules.map((s) => ({
            kind: OrderItemKind.FLIGHT,
            description: `${s.flight.flightNumber} ${s.flight.originCode}→${s.flight.destinationCode}`,
            quantity: d.pax,
            unitPrice: new Prisma.Decimal(econPrice),
            amount: new Prisma.Decimal(econPrice * d.pax),
            flightScheduleId: s.id,
            flightCabin: CabinClass.ECONOMY,
          })),
        },
        passengers: {
          create: [PASSENGER_LIU, ...(d.pax >= 2 ? [PASSENGER_WANG] : [])].map((p) => ({
            fullName: p.fullName,
            documentType: p.documentType,
            documentNumber: p.documentNumber,
            nationality: p.nationality,
            dateOfBirth: p.dateOfBirth,
          })),
        },
        // 已支付订单：建一条 Payment 行
        ...(d.paid
          ? {
              payments: {
                create: {
                  method: PaymentMethod.WECHAT_PAY,
                  amount: total,
                  status: PaymentStatus.SUCCEEDED,
                  paidAt: new Date(createdAt.getTime() + 5 * 60_000),
                  transactionId: `SBX-DEMO-${d.orderNumber}`,
                  gatewayPayload: { provider: 'sandbox', demo: true },
                },
              },
            }
          : {}),
      },
    });
    created++;
  }
  // eslint-disable-next-line no-console
  console.log(`  …Demo 订单：新增 ${created} 条，跳过 ${skipped} 条（共 ${DEMO_ORDERS.length}）`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
