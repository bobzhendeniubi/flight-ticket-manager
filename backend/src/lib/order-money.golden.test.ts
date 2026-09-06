/**
 * 订单金额「黄金」特征测试 · 纯函数计算点（vitest）
 *
 * 目的：在合并「单一口径函数 order-money」之前，把系统里每一个**不经数据库**就能调到的
 * 算钱点用同一组夹具订单（order-money.golden.fixtures.ts）钉死。合并后这些数一个都不许变——
 * 任何一处变了，要么是口径函数写错了，要么是发现了一处原本就不一致的实现（那要记进
 * docs/口径决议.md 的「待拍板 · 金额口径冲突」，不许顺手统一）。
 *
 * 覆盖的计算点：
 *   · 订单列表 / 详情 DTO：serializeOrder → effectivePayable / balanceDue
 *   · 三模板导出：buildOrderContext（结算价按人 / 均摊兜底 / 到账 / 尾款）+ orderToFullRows（是否清账等）
 *   · 全岗总表：orderToMasterRows（结算价 / 立减 / 尾款 / 到账 / 单房差 / 签证金额 / 是否清账 / 退款）
 *   · 分房表：buildRoomAllocationSheets → settlePrice
 *   · 每人份额三口径：perPaxSettlementByPassenger / perPaxVisaAmountByPassenger / perPaxSingleRoomDiffByPassenger
 *   · 提醒尾款 computeBalance、议价申请应收 receivableCny、行程单应付 computeEffectivePayable
 *   · 已收净额 netReceivedCny（lib/net-received）
 *
 * 数字是快照——第一次跑时由现有实现生成，此后是契约。读快照时可对照夹具头注释的手算值。
 */
import { describe, it, expect, vi } from 'vitest';

// 模块链路（orders.export-* → orders.service）顶层引用 prisma —— mock 掉
vi.mock('../db/prisma.js', () => ({ prisma: {} }));

import { serializeOrder } from '../modules/orders/orders.service.js';
import {
  buildOrderContext,
  orderToFullRows,
  perPaxSettlementByPassenger,
  perPaxVisaAmountByPassenger,
  perPaxSingleRoomDiffByPassenger,
  type OrderForTemplateExport,
} from '../modules/orders/orders.export-templates.js';
import { orderToMasterRows, type OrderForMasterExport } from '../modules/orders/orders.export-master.js';
import {
  buildRoomAllocationSheets,
  type RoomItemForExport,
} from '../modules/orders/orders.export-room-allocation.js';
import { computeBalance } from '../modules/reminders/reminders.rules.js';
import { receivableCny } from '../modules/settlement-requests/settlement-requests.service.js';
import { computeEffectivePayable } from './itinerary-pdf.js';
import { netReceivedCny, sumCompletedRefundCny } from './net-received.js';
import {
  allFixtures,
  completedRefunds,
  fixtureMultiPax,
  fixtureSwapped,
  D,
  type FixtureOrder,
} from './order-money.golden.fixtures.js';

const byId = (o: FixtureOrder) => o.orderNumber;

function mapToObj(m: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

describe('黄金 · 每人份额三口径（perPax*ByPassenger）', () => {
  it('六张夹具单逐人结算价 / 签证金额 / 单房差', () => {
    const out = Object.fromEntries(
      allFixtures().map((o) => [
        byId(o),
        {
          settle: mapToObj(perPaxSettlementByPassenger(o)),
          visa: mapToObj(perPaxVisaAmountByPassenger(o)),
          singleRoom: mapToObj(perPaxSingleRoomDiffByPassenger(o)),
        },
      ]),
    );
    expect(out).toMatchInlineSnapshot(`
      {
        "FTM2026082000001": {
          "settle": {
            "p1": 2229.5,
            "p2": 3029.5,
            "p3": 2129.5,
            "p4": 2229.5,
          },
          "singleRoom": {
            "p1": 300,
            "p2": 0,
            "p3": 0,
            "p4": 0,
          },
          "visa": {
            "p1": 240,
            "p2": 240,
            "p3": 0,
            "p4": 240,
          },
        },
        "FTM2026082000002": {
          "settle": {
            "p5": 3150,
            "p6": 3150,
          },
          "singleRoom": {
            "p5": 0,
            "p6": 0,
          },
          "visa": {
            "p5": 0,
            "p6": 0,
          },
        },
        "FTM2026082000003": {
          "settle": {
            "p7": 2633.33,
            "p8": 3033.33,
            "p9": 2633.34,
          },
          "singleRoom": {
            "p7": 200,
            "p8": 400,
            "p9": 0,
          },
          "visa": {
            "p7": 0,
            "p8": 0,
            "p9": 0,
          },
        },
        "FTM2026082000004": {
          "settle": {
            "p10": 3000,
          },
          "singleRoom": {
            "p10": 0,
          },
          "visa": {
            "p10": 0,
          },
        },
        "FTM2026082000005": {
          "settle": {
            "p11": 1040,
            "p12": 1040,
            "p13": 1040,
          },
          "singleRoom": {
            "p11": 0,
            "p12": 0,
            "p13": 0,
          },
          "visa": {
            "p11": 240,
            "p12": 240,
            "p13": 0,
          },
        },
        "FTM2026082000006": {
          "settle": {
            "p14": 1666.66,
            "p15": 1666.67,
          },
          "singleRoom": {
            "p14": 0,
            "p15": 0,
          },
          "visa": {
            "p14": 0,
            "p15": 0,
          },
        },
      }
    `);
  });

  it('F1 手算对拍：应收 9618，p2 +800 / p3 −100 → 基准 2229.5，合计恒等于应收', () => {
    const settle = perPaxSettlementByPassenger(fixtureMultiPax());
    expect(settle.get('p1')).toBe(2229.5);
    expect(settle.get('p2')).toBe(3029.5);
    expect(settle.get('p3')).toBe(2129.5);
    expect(settle.get('p4')).toBe(2229.5);
    expect([...settle.values()].reduce((s, v) => s + v, 0)).toBe(9618);
  });

  it('F3 手算对拍：换人费 450 不摊（excludeFromPerPax），份额合计 = 8100 + 200 = 8300 ≠ 应收 8750', () => {
    const settle = perPaxSettlementByPassenger(fixtureSwapped());
    expect(settle.get('p7')).toBe(2633.33);
    expect(settle.get('p8')).toBe(3033.33);
    expect(settle.get('p9')).toBe(2633.34);
    expect(Math.round([...settle.values()].reduce((s, v) => s + v, 0) * 100) / 100).toBe(8300);
  });
});

describe('黄金 · 订单 DTO（serializeOrder）应付 / 尾款', () => {
  it('六张夹具单的 effectivePayable / balanceDue 字符串', () => {
    const out = Object.fromEntries(
      allFixtures().map((o) => {
        const dto = serializeOrder(o as never) as { effectivePayable: string; balanceDue: string };
        return [byId(o), { effectivePayable: dto.effectivePayable, balanceDue: dto.balanceDue }];
      }),
    );
    expect(out).toMatchInlineSnapshot(`
      {
        "FTM2026082000001": {
          "balanceDue": "4618",
          "effectivePayable": "9618",
        },
        "FTM2026082000002": {
          "balanceDue": "-500",
          "effectivePayable": "6300",
        },
        "FTM2026082000003": {
          "balanceDue": "0",
          "effectivePayable": "8750",
        },
        "FTM2026082000004": {
          "balanceDue": "0",
          "effectivePayable": "3000",
        },
        "FTM2026082000005": {
          "balanceDue": "2120",
          "effectivePayable": "3120",
        },
        "FTM2026082000006": {
          "balanceDue": "0",
          "effectivePayable": "3333.33",
        },
      }
    `);
  });
});

describe('黄金 · 三模板导出 buildOrderContext / orderToFullRows', () => {
  it('订单上下文里的金额（结算价按人、均摊兜底、到账、尾款、签证、单房差）', () => {
    const out = Object.fromEntries(
      allFixtures().map((o) => {
        const ctx = buildOrderContext(o as unknown as OrderForTemplateExport);
        return [
          byId(o),
          {
            settleByPassenger: mapToObj(ctx.settleByPassenger),
            settlePerPax: ctx.settlePerPax,
            paidPerPax: ctx.paidPerPax,
            balancePerPax: ctx.balancePerPax,
            visaAmountByPassenger: mapToObj(ctx.visaAmountByPassenger),
            singleRoomDiffByPassenger: mapToObj(ctx.singleRoomDiffByPassenger),
          },
        ];
      }),
    );
    expect(out).toMatchInlineSnapshot(`
      {
        "FTM2026082000001": {
          "balancePerPax": 1154.5,
          "paidPerPax": 1250,
          "settleByPassenger": {
            "p1": 2229.5,
            "p2": 3029.5,
            "p3": 2129.5,
            "p4": 2229.5,
          },
          "settlePerPax": 2404.5,
          "singleRoomDiffByPassenger": {
            "p1": 300,
            "p2": 0,
            "p3": 0,
            "p4": 0,
          },
          "visaAmountByPassenger": {
            "p1": 240,
            "p2": 240,
            "p3": 0,
            "p4": 240,
          },
        },
        "FTM2026082000002": {
          "balancePerPax": 0,
          "paidPerPax": 3150,
          "settleByPassenger": {
            "p5": 3150,
            "p6": 3150,
          },
          "settlePerPax": 3150,
          "singleRoomDiffByPassenger": {
            "p5": 0,
            "p6": 0,
          },
          "visaAmountByPassenger": {
            "p5": 0,
            "p6": 0,
          },
        },
        "FTM2026082000003": {
          "balancePerPax": 0,
          "paidPerPax": 2916.67,
          "settleByPassenger": {
            "p7": 2633.33,
            "p8": 3033.33,
            "p9": 2633.34,
          },
          "settlePerPax": 2766.67,
          "singleRoomDiffByPassenger": {
            "p7": 200,
            "p8": 400,
            "p9": 0,
          },
          "visaAmountByPassenger": {
            "p7": 0,
            "p8": 0,
            "p9": 0,
          },
        },
        "FTM2026082000004": {
          "balancePerPax": 0,
          "paidPerPax": 3000,
          "settleByPassenger": {
            "p10": 3000,
          },
          "settlePerPax": 3000,
          "singleRoomDiffByPassenger": {
            "p10": 0,
          },
          "visaAmountByPassenger": {
            "p10": 0,
          },
        },
        "FTM2026082000005": {
          "balancePerPax": 706.67,
          "paidPerPax": 333.33,
          "settleByPassenger": {
            "p11": 1040,
            "p12": 1040,
            "p13": 1040,
          },
          "settlePerPax": 1040,
          "singleRoomDiffByPassenger": {
            "p11": 0,
            "p12": 0,
            "p13": 0,
          },
          "visaAmountByPassenger": {
            "p11": 240,
            "p12": 240,
            "p13": 0,
          },
        },
        "FTM2026082000006": {
          "balancePerPax": 0,
          "paidPerPax": 1666.67,
          "settleByPassenger": {
            "p14": 1666.66,
            "p15": 1666.67,
          },
          "settlePerPax": 1666.67,
          "singleRoomDiffByPassenger": {
            "p14": 0,
            "p15": 0,
          },
          "visaAmountByPassenger": {
            "p14": 0,
            "p15": 0,
          },
        },
      }
    `);
  });

  it('《全岗可用》每行金额列 + 是否清账', () => {
    const out = Object.fromEntries(
      allFixtures().map((o) => {
        const order = o as unknown as OrderForTemplateExport;
        const ctx = buildOrderContext(order);
        const rows = orderToFullRows(order, ctx, new Map(), 1);
        return [
          byId(o),
          rows.map((r) => ({
            pax: r.chineseName,
            settlePrice: r.settlePrice,
            settleReceived: r.settleReceived,
            balanceDue: r.balanceDue,
            singleRoomDiff: r.singleRoomDiff,
            visaAmount: r.visaAmount,
            settled: r.settled,
            refundAmount: r.refundAmount,
          })),
        ];
      }),
    );
    expect(out).toMatchInlineSnapshot(`
      {
        "FTM2026082000001": [
          {
            "balanceDue": 1154.5,
            "pax": "张三",
            "refundAmount": 0,
            "settlePrice": 2229.5,
            "settleReceived": 1250,
            "settled": "否",
            "singleRoomDiff": 300,
            "visaAmount": 240,
          },
          {
            "balanceDue": 1154.5,
            "pax": "李四",
            "refundAmount": 0,
            "settlePrice": 3029.5,
            "settleReceived": 1250,
            "settled": "否",
            "singleRoomDiff": 0,
            "visaAmount": 240,
          },
          {
            "balanceDue": 1154.5,
            "pax": "王五",
            "refundAmount": 0,
            "settlePrice": 2129.5,
            "settleReceived": 1250,
            "settled": "否",
            "singleRoomDiff": 0,
            "visaAmount": 0,
          },
          {
            "balanceDue": 1154.5,
            "pax": "赵六",
            "refundAmount": 0,
            "settlePrice": 2229.5,
            "settleReceived": 1250,
            "settled": "否",
            "singleRoomDiff": 0,
            "visaAmount": 240,
          },
        ],
        "FTM2026082000002": [
          {
            "balanceDue": 0,
            "pax": "孙七",
            "refundAmount": 500,
            "settlePrice": 3150,
            "settleReceived": 3150,
            "settled": "是",
            "singleRoomDiff": 0,
            "visaAmount": 0,
          },
          {
            "balanceDue": 0,
            "pax": "周八",
            "refundAmount": 500,
            "settlePrice": 3150,
            "settleReceived": 3150,
            "settled": "是",
            "singleRoomDiff": 0,
            "visaAmount": 0,
          },
        ],
        "FTM2026082000003": [
          {
            "balanceDue": 0,
            "pax": "吴九",
            "refundAmount": 0,
            "settlePrice": 2633.33,
            "settleReceived": 2916.67,
            "settled": "是",
            "singleRoomDiff": 200,
            "visaAmount": 0,
          },
          {
            "balanceDue": 0,
            "pax": "郑十",
            "refundAmount": 0,
            "settlePrice": 3033.33,
            "settleReceived": 2916.67,
            "settled": "是",
            "singleRoomDiff": 400,
            "visaAmount": 0,
          },
          {
            "balanceDue": 0,
            "pax": "钱一",
            "refundAmount": 0,
            "settlePrice": 2633.34,
            "settleReceived": 2916.67,
            "settled": "是",
            "singleRoomDiff": 0,
            "visaAmount": 0,
          },
        ],
        "FTM2026082000004": [
          {
            "balanceDue": 0,
            "pax": "冯二",
            "refundAmount": 2700,
            "settlePrice": 3000,
            "settleReceived": 3000,
            "settled": "是",
            "singleRoomDiff": 0,
            "visaAmount": 0,
          },
        ],
        "FTM2026082000005": [
          {
            "balanceDue": 706.67,
            "pax": "陈三",
            "refundAmount": 0,
            "settlePrice": 1040,
            "settleReceived": 333.33,
            "settled": "否",
            "singleRoomDiff": 0,
            "visaAmount": 240,
          },
          {
            "balanceDue": 706.67,
            "pax": "褚四",
            "refundAmount": 0,
            "settlePrice": 1040,
            "settleReceived": 333.33,
            "settled": "否",
            "singleRoomDiff": 0,
            "visaAmount": 240,
          },
          {
            "balanceDue": 706.67,
            "pax": "卫五",
            "refundAmount": 0,
            "settlePrice": 1040,
            "settleReceived": 333.33,
            "settled": "否",
            "singleRoomDiff": 0,
            "visaAmount": 0,
          },
        ],
        "FTM2026082000006": [
          {
            "balanceDue": 0,
            "pax": "蒋六",
            "refundAmount": 0,
            "settlePrice": 1666.66,
            "settleReceived": 1666.67,
            "settled": "是",
            "singleRoomDiff": 0,
            "visaAmount": 0,
          },
          {
            "balanceDue": 0,
            "pax": "沈七",
            "refundAmount": 0,
            "settlePrice": 1666.67,
            "settleReceived": 1666.67,
            "settled": "是",
            "singleRoomDiff": 0,
            "visaAmount": 0,
          },
        ],
      }
    `);
  });
});

describe('黄金 · 全岗总表 orderToMasterRows', () => {
  it('每行金额列（结算价 / 立减 / 尾款 / 到账 / 单房差 / 签证 / 是否清账 / 退款）', () => {
    const out = Object.fromEntries(
      allFixtures().map((o) => {
        const rows = orderToMasterRows(o as unknown as OrderForMasterExport, new Map(), 1);
        return [
          byId(o),
          rows.map((r) => ({
            pax: r.chineseName,
            settlePrice: r.settlePrice,
            settlementDiscountAmount: r.settlementDiscountAmount,
            balanceDue: r.balanceDue,
            settleReceived: r.settleReceived,
            singleRoomDiff: r.singleRoomDiff,
            visaAmount: r.visaAmount,
            settled: r.settled,
            refundAmount: r.refundAmount,
          })),
        ];
      }),
    );
    expect(out).toMatchInlineSnapshot(`
      {
        "FTM2026082000001": [
          {
            "balanceDue": 1154.5,
            "pax": "张三",
            "refundAmount": 0,
            "settlePrice": 2229.5,
            "settleReceived": 1250,
            "settled": "否",
            "settlementDiscountAmount": 258,
            "singleRoomDiff": 300,
            "visaAmount": 240,
          },
          {
            "balanceDue": 1154.5,
            "pax": "李四",
            "refundAmount": 0,
            "settlePrice": 3029.5,
            "settleReceived": 1250,
            "settled": "否",
            "settlementDiscountAmount": 258,
            "singleRoomDiff": 0,
            "visaAmount": 240,
          },
          {
            "balanceDue": 1154.5,
            "pax": "王五",
            "refundAmount": 0,
            "settlePrice": 2129.5,
            "settleReceived": 1250,
            "settled": "否",
            "settlementDiscountAmount": 258,
            "singleRoomDiff": 0,
            "visaAmount": 0,
          },
          {
            "balanceDue": 1154.5,
            "pax": "赵六",
            "refundAmount": 0,
            "settlePrice": 2229.5,
            "settleReceived": 1250,
            "settled": "否",
            "settlementDiscountAmount": 258,
            "singleRoomDiff": 0,
            "visaAmount": 240,
          },
        ],
        "FTM2026082000002": [
          {
            "balanceDue": 0,
            "pax": "孙七",
            "refundAmount": 500,
            "settlePrice": 3150,
            "settleReceived": 3150,
            "settled": "是",
            "settlementDiscountAmount": 0,
            "singleRoomDiff": 0,
            "visaAmount": 0,
          },
          {
            "balanceDue": 0,
            "pax": "周八",
            "refundAmount": 500,
            "settlePrice": 3150,
            "settleReceived": 3150,
            "settled": "是",
            "settlementDiscountAmount": 0,
            "singleRoomDiff": 0,
            "visaAmount": 0,
          },
        ],
        "FTM2026082000003": [
          {
            "balanceDue": 0,
            "pax": "吴九",
            "refundAmount": 0,
            "settlePrice": 2633.33,
            "settleReceived": 2916.67,
            "settled": "是",
            "settlementDiscountAmount": 0,
            "singleRoomDiff": 200,
            "visaAmount": 0,
          },
          {
            "balanceDue": 0,
            "pax": "郑十",
            "refundAmount": 0,
            "settlePrice": 3033.33,
            "settleReceived": 2916.67,
            "settled": "是",
            "settlementDiscountAmount": 0,
            "singleRoomDiff": 400,
            "visaAmount": 0,
          },
          {
            "balanceDue": 0,
            "pax": "钱一",
            "refundAmount": 0,
            "settlePrice": 2633.34,
            "settleReceived": 2916.67,
            "settled": "是",
            "settlementDiscountAmount": 0,
            "singleRoomDiff": 0,
            "visaAmount": 0,
          },
        ],
        "FTM2026082000004": [
          {
            "balanceDue": 0,
            "pax": "冯二",
            "refundAmount": 2700,
            "settlePrice": 3000,
            "settleReceived": 3000,
            "settled": "是",
            "settlementDiscountAmount": 0,
            "singleRoomDiff": 0,
            "visaAmount": 0,
          },
        ],
        "FTM2026082000005": [
          {
            "balanceDue": 706.67,
            "pax": "陈三",
            "refundAmount": 0,
            "settlePrice": 1040,
            "settleReceived": 333.33,
            "settled": "否",
            "settlementDiscountAmount": 0,
            "singleRoomDiff": 0,
            "visaAmount": 240,
          },
          {
            "balanceDue": 706.67,
            "pax": "褚四",
            "refundAmount": 0,
            "settlePrice": 1040,
            "settleReceived": 333.33,
            "settled": "否",
            "settlementDiscountAmount": 0,
            "singleRoomDiff": 0,
            "visaAmount": 240,
          },
          {
            "balanceDue": 706.67,
            "pax": "卫五",
            "refundAmount": 0,
            "settlePrice": 1040,
            "settleReceived": 333.33,
            "settled": "否",
            "settlementDiscountAmount": 0,
            "singleRoomDiff": 0,
            "visaAmount": 0,
          },
        ],
        "FTM2026082000006": [
          {
            "balanceDue": 0,
            "pax": "蒋六",
            "refundAmount": 0,
            "settlePrice": 1666.66,
            "settleReceived": 1666.67,
            "settled": "是",
            "settlementDiscountAmount": 0,
            "singleRoomDiff": 0,
            "visaAmount": 0,
          },
          {
            "balanceDue": 0,
            "pax": "沈七",
            "refundAmount": 0,
            "settlePrice": 1666.67,
            "settleReceived": 1666.67,
            "settled": "是",
            "settlementDiscountAmount": 0,
            "singleRoomDiff": 0,
            "visaAmount": 0,
          },
        ],
      }
    `);
  });
});

describe('黄金 · 分房表 buildRoomAllocationSheets → settlePrice', () => {
  function hotelItem(o: FixtureOrder, checkIn: string): RoomItemForExport {
    return {
      id: `${o.id}-hotel`,
      orderId: o.id,
      kind: 'HOTEL',
      hotelCheckIn: D(checkIn),
      hotelCheckOut: D(checkIn),
      randomStarTier: null,
      quantity: 1,
      hotelRoomType: { hotelId: 'h1', name: '标准双床', bedType: '双床', capacity: 2, hotel: { name: 'B酒店' } },
      order: {
        ...o,
        items: o.items.map((it) => ({
          id: it.id,
          kind: it.kind,
          amount: it.amount,
          description: it.description,
          passengerId: it.passengerId,
          metadata: it.metadata,
          flightSchedule: it.flightSchedule
            ? { departureTime: it.flightSchedule.departureTime, departureTz: it.flightSchedule.departureTz }
            : null,
        })),
      },
    } as unknown as RoomItemForExport;
  }

  it('F1（按人不同价）与 F3（换人费不摊）逐人 settlePrice', () => {
    const sheets = buildRoomAllocationSheets([
      hotelItem(fixtureMultiPax(), '2026-09-10'),
      hotelItem(fixtureSwapped(), '2026-09-12'),
    ]);
    const out = sheets.map((s) => ({
      sheet: s.name,
      rows: s.rows.map((r) => ({ name: r.chineseName, settlePrice: r.settlePrice })),
    }));
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "rows": [
            {
              "name": "张三",
              "settlePrice": 2229.5,
            },
            {
              "name": "王五",
              "settlePrice": 2129.5,
            },
            {
              "name": "李四",
              "settlePrice": 3029.5,
            },
            {
              "name": "赵六",
              "settlePrice": 2229.5,
            },
          ],
          "sheet": "9-10",
        },
        {
          "rows": [
            {
              "name": "吴九",
              "settlePrice": 2633.33,
            },
            {
              "name": "钱一",
              "settlePrice": 2633.34,
            },
            {
              "name": "郑十",
              "settlePrice": 3033.33,
            },
          ],
          "sheet": "9-12",
        },
      ]
    `);
  });
});

describe('黄金 · 提醒尾款 / 议价应收 / 行程单应付 / 已收净额', () => {
  it('六张夹具单', () => {
    const out = Object.fromEntries(
      allFixtures().map((o) => [
        byId(o),
        {
          reminderBalance: computeBalance(o).toString(),
          receivableCny: receivableCny(o),
          itineraryPayable: computeEffectivePayable(o.total.toString(), o.adjustmentCny),
          netReceived: netReceivedCny(o, sumCompletedRefundCny(completedRefunds(o))),
        },
      ]),
    );
    expect(out).toMatchInlineSnapshot(`
      {
        "FTM2026082000001": {
          "itineraryPayable": "9618.00",
          "netReceived": 5000,
          "receivableCny": 9618,
          "reminderBalance": "4618",
        },
        "FTM2026082000002": {
          "itineraryPayable": "6300.00",
          "netReceived": 5800,
          "receivableCny": 6300,
          "reminderBalance": "-500",
        },
        "FTM2026082000003": {
          "itineraryPayable": "8750.00",
          "netReceived": 8750,
          "receivableCny": 8750,
          "reminderBalance": "0",
        },
        "FTM2026082000004": {
          "itineraryPayable": "3000.00",
          "netReceived": 300,
          "receivableCny": 3000,
          "reminderBalance": "0",
        },
        "FTM2026082000005": {
          "itineraryPayable": "3120.00",
          "netReceived": 1000,
          "receivableCny": 3120,
          "reminderBalance": "2120",
        },
        "FTM2026082000006": {
          "itineraryPayable": "3333.33",
          "netReceived": 3333.33,
          "receivableCny": 3333.33,
          "reminderBalance": "0",
        },
      }
    `);
  });
});
