/**
 * 导出侧「出发日精确细筛」的无锚点口径 · 单测（vitest，mock Prisma）
 *
 * 背景（反馈：签证岗）：纯签证单既没有航班行、也没有酒店入住日，从前派生不出「出发日」，
 * 于是带出发日期区间的导出把它**静默排除**——签证岗按日期导出，自己的单一张都不在里面，
 * 而且没有任何提示。
 *
 * 拍板口径：签证业务必有「预计出行日期」这个业务锚点（OrderItem.visaIntendedDate，可空）。
 *   导出 = 「有锚点按锚点筛，无锚点的**签证单**保留」；
 *   列表 = 「有锚点按锚点筛，无锚点排除」（无日期单否则会出现在每一个日期区间里，筛选失效）。
 * 列表侧口径的用例在 orders.service.test.ts 的 filterOrderIdsByDepartDate describe 里。
 *
 * 豁免只给签证单（收窄）：例外的理由是「签证业务没有航班和住宿、无处归日」，只有涉签的单
 * 才配得上它；空单 / 纯接送单 / 资料还没录全的机酒单没有这个理由，无条件保留会让它们混进
 * **每一个**指定日期的导出。取数层（buildOrderFilterWhere 的 includeAnchorless 分支）同口径收窄。
 *
 * 覆盖：
 *   1. 出发日派生的三级回退优先级（航班 → 酒店入住 → 签证预计出行日）。
 *   2. 导出侧无锚点签证单保留；有锚点但不在窗口内的单照旧剔除（「保留」不等于放弃过滤）。
 *   3. 无锚点且不涉签的单不再混入（本次收窄）。
 *   4. 开区间 / 不给区间的边界行为。
 *   5. 录单输入 visaIntendedDate 'YYYY-MM-DD' → priced 行落 UTC 零点 Date（供 createOrder 写库）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    visa: { findUnique: vi.fn() },
    flightSchedule: { findMany: vi.fn() },
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));

import { filterExportOrdersByDepartDate } from './orders.export-depart-filter.js';
import { OrderService } from './orders.service.js';
import type { OrderItemInput } from './orders.schemas.js';

// ── fixtures：三类锚点各一，缺席的锚点一律显式落 null（贴近真实联查形状）──────────
const flight = (departISO: string) => ({
  kind: 'FLIGHT',
  flightSchedule: { departureTime: new Date(departISO) },
  hotelCheckIn: null,
  visaIntendedDate: null,
});
const hotel = (checkIn: string) => ({
  kind: 'HOTEL',
  flightSchedule: null,
  hotelCheckIn: new Date(`${checkIn}T00:00:00.000Z`),
  visaIntendedDate: null,
});
/** 签证行：填了预计出行日期 = 有锚点；传 null = 行程未定、无锚点。 */
const visa = (intendedDate: string | null) => ({
  kind: 'VISA',
  flightSchedule: null,
  hotelCheckIn: null,
  visaIntendedDate: intendedDate ? new Date(`${intendedDate}T00:00:00.000Z`) : null,
});
/** 接送行：任何日期锚点都没有，也不涉签 —— 无锚点豁免不该罩着它。 */
const transfer = () => ({
  kind: 'TRANSFER',
  flightSchedule: null,
  hotelCheckIn: null,
  visaIntendedDate: null,
});
/** 资料不全的酒店行：房型选了但入住日还没录 → 无锚点，且不涉签。 */
const hotelNoCheckIn = () => ({
  kind: 'HOTEL',
  flightSchedule: null,
  hotelCheckIn: null,
  visaIntendedDate: null,
});
/** 套餐行：bundle.items 是套餐组件 JSON；含 { kind: 'VISA' } = 该套餐涉签。 */
const bundleRow = (componentKinds: string[]) => ({
  kind: 'BUNDLE',
  flightSchedule: null,
  hotelCheckIn: null,
  visaIntendedDate: null,
  bundle: { items: componentKinds.map((kind) => ({ kind })) },
});
const mkOrder = (id: string, items: unknown[]) => ({ id, items });

describe('filterExportOrdersByDepartDate · 无锚点的签证单保留（导出口径）', () => {
  it('纯签证单填了预计出行日期 → 按它归日，与航班/酒店单一视同仁', () => {
    const orders = [
      mkOrder('visa-15', [visa('2026-09-15')]),
      mkOrder('visa-16', [visa('2026-09-16')]),
      mkOrder('flight-15', [flight('2026-09-15T09:00:00.000Z')]),
      mkOrder('hotel-15', [hotel('2026-09-15')]),
    ];
    const kept = filterExportOrdersByDepartDate(orders, '2026-09-15', '2026-09-15');
    expect(kept.map((o) => o.id)).toEqual(['visa-15', 'flight-15', 'hotel-15']);
  });

  it('纯签证单没填预计出行日期 → 无锚点，保留（这是本次改掉的老口径）', () => {
    const orders = [
      mkOrder('visa-none', [visa(null)]),
      mkOrder('flight-15', [flight('2026-09-15T09:00:00.000Z')]),
    ];
    const kept = filterExportOrdersByDepartDate(orders, '2026-09-15', '2026-09-15');
    expect(kept.map((o) => o.id)).toEqual(['visa-none', 'flight-15']);
  });

  it('「无锚点保留」不等于放弃过滤：有锚点但不在窗口内的单照旧剔除', () => {
    const orders = [
      mkOrder('visa-none', [visa(null)]),
      mkOrder('visa-20-out', [visa('2026-09-20')]),
      mkOrder('flight-20-out', [flight('2026-09-20T09:00:00.000Z')]),
      mkOrder('flight-15-in', [flight('2026-09-15T09:00:00.000Z')]),
    ];
    const kept = filterExportOrdersByDepartDate(orders, '2026-09-15', '2026-09-15');
    expect(kept.map((o) => o.id)).toEqual(['visa-none', 'flight-15-in']);
  });

  it('含签证组件的套餐单没有任何日期 → 保留（涉签判定认套餐组件，不止 VISA 行）', () => {
    const kept = filterExportOrdersByDepartDate(
      [mkOrder('bundle-visa', [bundleRow(['HOTEL', 'VISA'])])],
      '2026-09-15',
      '2026-09-15',
    );
    expect(kept.map((o) => o.id)).toEqual(['bundle-visa']);
  });

  it('回退是分级的：有航班不看签证日期，有酒店也优先于签证日期', () => {
    // 航班 9/15 + 签证预计 9/20 → 整单出发日 = 9/15
    const withFlight = mkOrder('wf', [flight('2026-09-15T09:00:00.000Z'), visa('2026-09-20')]);
    // 无航班，酒店入住 9/16 + 签证预计 9/20 → 整单出发日 = 9/16
    const withHotel = mkOrder('wh', [hotel('2026-09-16'), visa('2026-09-20')]);
    expect(
      filterExportOrdersByDepartDate([withFlight, withHotel], '2026-09-20', '2026-09-20').map(
        (o) => o.id,
      ),
    ).toEqual([]);
    expect(
      filterExportOrdersByDepartDate([withFlight], '2026-09-15', '2026-09-15').map((o) => o.id),
    ).toEqual(['wf']);
    expect(
      filterExportOrdersByDepartDate([withHotel], '2026-09-16', '2026-09-16').map((o) => o.id),
    ).toEqual(['wh']);
  });

  it('多张签证行取最早的预计出行日期（与航班/酒店同为「最早」口径）', () => {
    // 顺序刻意先晚后早，验证取的是「最早」而非「第一条」。
    const multi = mkOrder('vm', [visa('2026-09-20'), visa('2026-09-15')]);
    expect(
      filterExportOrdersByDepartDate([multi], '2026-09-15', '2026-09-15').map((o) => o.id),
    ).toEqual(['vm']);
    expect(filterExportOrdersByDepartDate([multi], '2026-09-20', '2026-09-20')).toEqual([]);
  });

  it('未给 travelFrom/travelTo（勾选/整班导出）→ 原样放行，不过滤', () => {
    const orders = [mkOrder('a', [flight('2026-09-20T09:00:00.000Z')]), mkOrder('b', [visa(null)])];
    expect(filterExportOrdersByDepartDate(orders, undefined, undefined).map((o) => o.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('开区间：只给 travelFrom → 起点及之后的有锚点单 + 全部无锚点签证单', () => {
    const orders = [
      mkOrder('visa-10-out', [visa('2026-09-10')]),
      mkOrder('visa-16-in', [visa('2026-09-16')]),
      mkOrder('visa-none', [visa(null)]),
    ];
    const kept = filterExportOrdersByDepartDate(orders, '2026-09-15', undefined);
    expect(kept.map((o) => o.id)).toEqual(['visa-16-in', 'visa-none']);
  });
});

// ── 收窄：无锚点豁免只给涉签单 ────────────────────────────────────────────────
// 老口径「没有日期锚点就保留」把与签证无关的残缺单也放了进来 —— 它们没有「无处归日」这个
// 理由，却会出现在**每一个**指定日期的导出里，按日期出表的岗位每天都得手工划掉同一批单。
describe('filterExportOrdersByDepartDate · 无锚点且不涉签的单不再混入', () => {
  it('完全没有行的空单 → 剔除（既没有日期，也没有任何要办的签证）', () => {
    const kept = filterExportOrdersByDepartDate(
      [mkOrder('empty', []), mkOrder('flight-15', [flight('2026-09-15T09:00:00.000Z')])],
      '2026-09-15',
      '2026-09-15',
    );
    expect(kept.map((o) => o.id)).toEqual(['flight-15']);
  });

  it('纯接送单（无日期、不涉签）→ 剔除', () => {
    const kept = filterExportOrdersByDepartDate(
      [mkOrder('transfer-only', [transfer()])],
      '2026-09-15',
      '2026-09-15',
    );
    expect(kept).toEqual([]);
  });

  it('资料不全的机酒单（房型录了、入住日没录）→ 剔除，不再每天混进导出', () => {
    const kept = filterExportOrdersByDepartDate(
      [mkOrder('hotel-draft', [hotelNoCheckIn()])],
      '2026-09-15',
      '2026-09-15',
    );
    expect(kept).toEqual([]);
  });

  it('不含签证组件的套餐单（无日期）→ 剔除', () => {
    const kept = filterExportOrdersByDepartDate(
      [mkOrder('bundle-no-visa', [bundleRow(['HOTEL', 'TRANSFER'])])],
      '2026-09-15',
      '2026-09-15',
    );
    expect(kept).toEqual([]);
  });

  it('残缺行里只要混着一条 VISA 行就仍保留（涉签是「有没有」，不是「全不全」）', () => {
    const kept = filterExportOrdersByDepartDate(
      [mkOrder('mixed', [transfer(), hotelNoCheckIn(), visa(null)])],
      '2026-09-15',
      '2026-09-15',
    );
    expect(kept.map((o) => o.id)).toEqual(['mixed']);
  });

  it('套餐行没联查到 bundle（bundle 为 null）→ 不当涉签，剔除（不猜）', () => {
    const kept = filterExportOrdersByDepartDate(
      [
        mkOrder('bundle-unloaded', [
          { kind: 'BUNDLE', flightSchedule: null, hotelCheckIn: null, visaIntendedDate: null },
        ]),
      ],
      '2026-09-15',
      '2026-09-15',
    );
    expect(kept).toEqual([]);
  });

  it('不给日期区间时收窄不生效：勾选/整班导出仍原样放行', () => {
    const orders = [mkOrder('empty', []), mkOrder('transfer-only', [transfer()])];
    expect(filterExportOrdersByDepartDate(orders, undefined, undefined).map((o) => o.id)).toEqual([
      'empty',
      'transfer-only',
    ]);
  });
});

// ── 录单输入 → priced 行：'YYYY-MM-DD' 折 UTC 零点，供 createOrder 落 @db.Date 列 ──
// priceAndValidateItems 为 private——按既有惯例用括号访问穿透（不改可见性）。
describe('priceAndValidateItems · VISA 行持久化 visaIntendedDate', () => {
  type PricedRow = { kind: string; visaId?: string; visaIntendedDate?: Date };
  type PriceFn = (
    items: OrderItemInput[],
    flightSettlementPriceCny?: number,
    passengers?: unknown,
    allowClientPricedGround?: boolean,
  ) => Promise<PricedRow[]>;
  const service = new OrderService();
  const priceItems = (
    service as unknown as { priceAndValidateItems: PriceFn }
  ).priceAndValidateItems.bind(service);

  const visaInput = (extra: Record<string, unknown>): OrderItemInput =>
    ({
      kind: 'VISA',
      description: '某国电子签 30 天',
      quantity: 1,
      unitPrice: 480,
      ...extra,
    }) as OrderItemInput;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.visa.findUnique.mockResolvedValue({
      basePrice: 480,
      expressSurcharge: null,
      expressTiers: null,
      costPriceCny: 300,
      isActive: true,
    });
  });

  it('填了预计出行日期 → priced 行落 UTC 零点 Date（不因本机时区漂前/漂后一天）', async () => {
    const priced = await priceItems([
      visaInput({ visaId: 'visa-1', visaIntendedDate: '2026-09-15' }),
    ]);
    expect(priced).toHaveLength(1);
    expect(priced[0].visaIntendedDate).toEqual(new Date('2026-09-15T00:00:00.000Z'));
  });

  it('没填 → undefined（createOrder 落 null，老数据与行程未定的单行为不变）', async () => {
    const priced = await priceItems([visaInput({ visaId: 'visa-1' })]);
    expect(priced[0].visaIntendedDate).toBeUndefined();
  });

  it('无产品 id 的手录签证行（后台/代理）同样带得上预计出行日期', async () => {
    const priced = await priceItems(
      [visaInput({ visaIntendedDate: '2026-09-15' })],
      undefined,
      undefined,
      true, // allowClientPricedGround：后台/代理手录
    );
    expect(priced[0].visaIntendedDate).toEqual(new Date('2026-09-15T00:00:00.000Z'));
  });
});
