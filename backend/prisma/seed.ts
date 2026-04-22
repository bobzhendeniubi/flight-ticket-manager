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

  // ── CommissionRule 默认费率（按产品类型 + 层级） ──
  // 不变式：child rate ≤ parent rate
  // 1 级 FLIGHT 10% / HOTEL 8% / TRANSFER 15% / VISA 12%
  // 2 级 FLIGHT 6%  / HOTEL 5% / TRANSFER 10% / VISA 8%
  // 3 级 FLIGHT 3%  / HOTEL 3% / TRANSFER 6%  / VISA 5%
  const commissionSeed: Array<{ agentId: string; rates: Record<'FLIGHT'|'HOTEL'|'TRANSFER'|'VISA', number> }> = [
    { agentId: agent1.id, rates: { FLIGHT: 0.10, HOTEL: 0.08, TRANSFER: 0.15, VISA: 0.12 } },
    { agentId: agent2.id, rates: { FLIGHT: 0.06, HOTEL: 0.05, TRANSFER: 0.10, VISA: 0.08 } },
    { agentId: agent3.id, rates: { FLIGHT: 0.03, HOTEL: 0.03, TRANSFER: 0.06, VISA: 0.05 } },
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
    '2级代理(父=1级)': agent2User.email,
    '3级代理(父=2级)': agent3User.email,
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
    { key: 'h1', name: '岘港四季度假村', nameEn: 'Four Seasons Resort The Nam Hai', cityCode: 'DAD', area: '美溪海滩 / 会安之间', address: 'Hamlet 1, Dien Duong, Dien Ban, Quang Nam', stars: 5, basePrice: 3280, rating: 4.9, reviewCount: 2891, emoji: '🏝️', photo: 'https://images.unsplash.com/photo-1582719508461-905c673771fd?w=600&h=400&fit=crop', amenities: ['私人海滩', '全海景别墅', '3 个无边泳池', '含自助早餐', '免费班车', 'SPA'], highlight: '全别墅式私密度假，The Nam Hai 独家 1km 海岸线' },
    { key: 'h2', name: '岘港洲际半岛度假村', nameEn: 'InterContinental Danang Sun Peninsula Resort', cityCode: 'DAD', area: '山茶半岛', address: 'Bai Bac, Son Tra Peninsula, Danang', stars: 5, basePrice: 3680, rating: 4.9, reviewCount: 3421, emoji: '🌊', photo: 'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=600&h=400&fit=crop', amenities: ['私人海湾', '缆车', '米其林餐厅 La Maison 1888', '日落无敌海景', '豪华 SPA'], highlight: 'Bill Bensley 设计，山茶半岛独占海湾' },
    { key: 'h3', name: '岘港凯悦度假村', nameEn: 'Hyatt Regency Danang Resort and Spa', cityCode: 'DAD', area: '美溪海滩', address: '5 Truong Sa Street, Hoa Hai Ward, Danang', stars: 5, basePrice: 1880, rating: 4.7, reviewCount: 4215, emoji: '🏖️', photo: 'https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=600&h=400&fit=crop', amenities: ['5 个泳池', '直通海滩', '儿童俱乐部', '含早餐', '免费机场班车'], highlight: '美溪海滩热门家庭首选，亲子设施完善' },
    { key: 'h4', name: '岘港铂尔曼海滩度假村', nameEn: 'Pullman Danang Beach Resort', cityCode: 'DAD', area: '美溪海滩', address: '101 Vo Nguyen Giap, Danang', stars: 5, basePrice: 1480, rating: 4.6, reviewCount: 2108, emoji: '🏨', photo: 'https://images.unsplash.com/photo-1445019980597-93fa8acb246c?w=600&h=400&fit=crop', amenities: ['海滩泳池', '水疗中心', '含早餐', '儿童乐园'], highlight: '性价比首选，美溪海滩中心位置' },
    { key: 'h5', name: '会安阿南塔拉度假村', nameEn: 'Anantara Hoi An Resort', cityCode: 'HOA', area: '会安古城', address: '1 Pham Hong Thai, Hoi An', stars: 5, basePrice: 2280, rating: 4.8, reviewCount: 1892, emoji: '🏮', photo: 'https://images.unsplash.com/photo-1578662996442-48f60103fc96?w=600&h=400&fit=crop', amenities: ['河畔泳池', '古城步行 5 分钟', '越南传统建筑', 'SPA'], highlight: '会安古城中心，步行即达灯笼市集' },
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
    if (existing) {
      await prisma.hotel.update({
        where: { id: existing.id },
        data: {
          nameEn: h.nameEn, area: h.area, address: h.address, starRating: h.stars,
          basePrice: h.basePrice, rating: h.rating, reviewCount: h.reviewCount,
          emoji: h.emoji, photos: [h.photo], amenities: h.amenities, highlight: h.highlight, isActive: true,
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
          starRating: h.stars, basePrice: h.basePrice, rating: h.rating, reviewCount: h.reviewCount,
          emoji: h.emoji, photos: [h.photo], amenities: h.amenities, highlight: h.highlight, isActive: true,
          roomTypes: { create: rooms },
        },
      });
    }
  }
}

async function seedTransfers() {
  const TRANSFERS = [
    { name: '岘港机场接送 · 经济轿车', vehicleType: '舒适型轿车（4 座）', capacity: 3, basePrice: 98, originArea: '岘港机场 (DAD)', destArea: '美溪海滩 / 市区任一酒店', emoji: '🚗', photo: 'https://images.unsplash.com/photo-1549317661-bd32c8ce0afa?w=600&h=400&fit=crop', features: ['含中文司机', '免费等候 60 分钟', '含儿童安全座椅', '矿泉水'], duration: '约 15 分钟' },
    { name: '岘港机场接送 · 7 座商务车', vehicleType: '7 座 MPV（如丰田 Innova）', capacity: 6, basePrice: 188, originArea: '岘港机场 (DAD)', destArea: '美溪海滩 / 山茶半岛 / 市区', emoji: '🚐', photo: 'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?w=600&h=400&fit=crop', features: ['家庭首选', '6 大件行李空间', '中文司机', '免费等候 60 分钟'], duration: '约 15–30 分钟' },
    { name: '岘港 → 会安古城 专车', vehicleType: '舒适型轿车 / 商务车', capacity: 6, basePrice: 248, originArea: '岘港酒店', destArea: '会安古城', emoji: '🏮', photo: 'https://images.unsplash.com/photo-1519641471654-76ce0107ad1b?w=600&h=400&fit=crop', features: ['单程约 45 分钟', '可中途停美溪海滩拍照', '含中文司机'], duration: '约 45 分钟' },
    { name: '巴拿山 1 日包车', vehicleType: '7 座商务车', capacity: 6, basePrice: 588, originArea: '岘港酒店', destArea: '巴拿山法国小镇 + 佛手黄金桥', emoji: '🌉', photo: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=600&h=400&fit=crop', features: ['8 小时包车', '含门票预订代购', '含中文司机', '可加购法式小镇午餐'], duration: '单程约 40 分钟' },
    { name: '岘港 → 顺化故都 1 日游包车', vehicleType: '7 座商务车', capacity: 6, basePrice: 888, originArea: '岘港酒店', destArea: '海云岭 → 顺化皇城 → 返回', emoji: '🏯', photo: 'https://images.unsplash.com/photo-1469854523086-cc02fe5d8800?w=600&h=400&fit=crop', features: ['途经海云岭观景台', '包含顺化景点解说', '10 小时包车', '中文司机'], duration: '全程约 10 小时' },
    { name: '岘港 → 美山圣地 半日包车', vehicleType: '舒适型轿车 / 商务车', capacity: 6, basePrice: 488, originArea: '岘港酒店', destArea: '美山遗址（UNESCO）→ 返回', emoji: '🛕', photo: 'https://images.unsplash.com/photo-1545569341-9eb8b30979d9?w=600&h=400&fit=crop', features: ['UNESCO 占婆遗址', '5 小时包车', '中文司机', '含矿泉水'], duration: '约 5 小时' },
  ];

  for (const t of TRANSFERS) {
    const existing = await prisma.transfer.findFirst({ where: { name: t.name } });
    if (existing) {
      await prisma.transfer.update({ where: { id: existing.id }, data: { ...t, basePrice: t.basePrice, isActive: true } });
    } else {
      await prisma.transfer.create({ data: { ...t, isActive: true } });
    }
  }
}

async function seedVisas() {
  const VISAS = [
    { destinationCountry: 'VN', country: '越南', flag: '🇻🇳', visaType: 'e_visa', visaName: '电子签证 E-visa · 30 天单次', processingDays: 3, basePrice: 280, expressSurcharge: 150, validityMonths: 1, highlight: '最热销 · 全流程线上', requiredDocs: ['护照首页扫描件', '2 寸白底照片电子版'] },
    { destinationCountry: 'VN', country: '越南', flag: '🇻🇳', visaType: 'e_visa_90d', visaName: '电子签证 E-visa · 90 天多次', processingDays: 5, basePrice: 680, expressSurcharge: 300, validityMonths: 3, highlight: '适合多次往返商务旅客', requiredDocs: ['护照首页扫描件', '2 寸白底照片电子版', '行程单'] },
    { destinationCountry: 'VN', country: '越南', flag: '🇻🇳', visaType: 'visa_on_arrival', visaName: '落地签批文', processingDays: 2, basePrice: 180, expressSurcharge: 80, validityMonths: 1, highlight: '最快办理，适合临时出行', requiredDocs: ['护照首页扫描件'] },
    { destinationCountry: 'VN', country: '越南', flag: '🇻🇳', visaType: 'business_1y', visaName: '商务邀请函签证（1 年多次）', processingDays: 10, basePrice: 980, expressSurcharge: 500, validityMonths: 12, highlight: '需我方协助发邀请函', requiredDocs: ['护照首页扫描件', '照片', '在职证明', '越南公司邀请函'] },
    { destinationCountry: 'KH', country: '柬埔寨', flag: '🇰🇭', visaType: 'e_visa', visaName: '电子签证 E-visa', processingDays: 3, basePrice: 320, expressSurcharge: 120, validityMonths: 3, requiredDocs: ['护照扫描件', '照片'] },
    { destinationCountry: 'TH', country: '泰国', flag: '🇹🇭', visaType: 'tourist', visaName: '单次旅游签证', processingDays: 5, basePrice: 280, expressSurcharge: 150, validityMonths: 3, requiredDocs: ['护照原件', '2 寸白底照片', '身份证复印件', '在职证明'] },
  ];

  for (const v of VISAS) {
    const existing = await prisma.visa.findFirst({
      where: { destinationCountry: v.destinationCountry, visaType: v.visaType },
    });
    if (existing) {
      await prisma.visa.update({ where: { id: existing.id }, data: { ...v, isActive: true } });
    } else {
      await prisma.visa.create({ data: { ...v, isActive: true } });
    }
  }
}

async function seedBundles() {
  const BUNDLES = [
    {
      name: '经典度假 3 晚 · 凯悦海景',
      tagline: '来回机票 + 凯悦海景 3 晚 + 来回接送',
      emoji: '🏖️',
      flightPax: 2,
      groundDiscount: 380,
      suitableFor: '2 人 · 情侣/家庭',
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
      flightPax: 2,
      groundDiscount: 1200,
      suitableFor: '2 人 · 蜜月/纪念日',
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
      flightPax: 1,
      groundDiscount: 200,
      suitableFor: '1 人 · 商务',
      items: [
        { kind: 'FLIGHT', productName: 'QH 澳门↔岘港 来回商务舱 × 1 人', qty: 1, unitPrice: 0 },
        { kind: 'HOTEL', productName: '馨乐庭蓝湾公寓 市区 1 晚', qty: 1, unitPrice: 580 },
        { kind: 'TRANSFER', productName: '岘港机场接送（豪华轿车 来回）', qty: 2, unitPrice: 388 },
        { kind: 'VISA', productName: '越南落地签批文', qty: 1, unitPrice: 180 },
      ],
    },
  ];

  for (const b of BUNDLES) {
    const existing = await prisma.bundle.findFirst({ where: { name: b.name } });
    if (existing) {
      await prisma.bundle.update({
        where: { id: existing.id },
        data: { ...b, items: b.items, isActive: true },
      });
    } else {
      await prisma.bundle.create({ data: { ...b, items: b.items, isActive: true } });
    }
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
