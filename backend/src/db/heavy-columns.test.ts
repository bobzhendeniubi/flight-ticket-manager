/**
 * 图片大字段不读（db/heavy-columns.ts）· 单元测试
 *
 * 盯三件事：
 *   1. heavyColumnReads 本身的口径（select / include / omit / 嵌套关系）—— 它是下面断言的尺子，尺子先得准；
 *   2. 「不需要图片字节」的读路径（导出、对账等），发给 Prisma 的每一次查询都不读
 *      Passenger.passportPhotoUrl / Payment.proofUrl / Receipt.proofUrl。做法同 orders.export-fetch.test.ts：
 *      注入记录调用参数的假 client，跑一遍真实的构建函数，再逐条断言捕获到的查询参数 —— 以后有人把
 *      include 改回 `passengers: true`，或新加一层 `order: { include: { passengers: true } }`，这里就会红；
 *   3. 对照组：护照包 / 房控护照包 / 签证台按单取图这些**要字节**的路径照旧整列读 —— omit 不能越界，
 *      越界的后果是导出的护照包静默没图。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}
type Responder = (call: RecordedCall) => unknown;

// 记录型假 client：任意 model.method 都能调，调用参数照单全收；返回值默认「空」（findMany → []、
// findUnique → null、count → 0），个别用例用 respondWith 给定返回，让构建函数走到要测的那条查询。
const { recorder } = vi.hoisted(() => {
  const calls: RecordedCall[] = [];
  let responder: Responder = () => undefined;
  const emptyResult = (method: string): unknown => {
    if (method === 'findMany' || method === 'groupBy') return [];
    if (method === 'count') return 0;
    if (method === 'aggregate') return { _sum: {}, _count: { _all: 0 }, _min: {}, _max: {} };
    return null;
  };
  const delegate = (model: string): unknown =>
    new Proxy(
      {},
      {
        get: (_target, method) => async (args?: unknown) => {
          const call = { model, method: String(method), args };
          calls.push(call);
          const custom = responder(call);
          return custom !== undefined ? custom : emptyResult(String(method));
        },
      },
    );
  const client: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_target, prop) => {
        const key = String(prop);
        if (key === 'then') return undefined; // 不是 thenable（await client 不该被当成 Promise）
        if (key.startsWith('$queryRaw') || key.startsWith('$executeRaw')) return async () => [];
        if (key === '$transaction') {
          return async (arg: unknown) =>
            typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(client) : Promise.all(arg as unknown[]);
        }
        return delegate(key);
      },
    },
  );
  return {
    recorder: {
      client,
      calls,
      respondWith(fn: Responder): void {
        responder = fn;
      },
      reset(): void {
        calls.length = 0;
        responder = () => undefined;
      },
    },
  };
});

vi.mock('./prisma.js', () => ({ prisma: recorder.client }));

import {
  HEAVY_COLUMNS,
  PASSENGERS_WITHOUT_PHOTO,
  PASSENGER_PHOTO_OMIT,
  PAYMENTS_WITHOUT_PROOF,
  PAYMENT_PROOF_OMIT,
  RECEIPT_PROOF_OMIT,
  heavyColumnReads,
} from './heavy-columns.js';
import { buildMasterExportWorkbook } from '../modules/orders/orders.export-master.js';
import { buildOrderTemplateExportWorkbook } from '../modules/orders/orders.export-templates.js';
import { buildRoomAllocationWorkbook } from '../modules/orders/orders.export-room-allocation.js';
import { buildOrdersBySchedule } from '../modules/orders/orders.export.js';
import { queryOrdersByIdsForVisa } from '../modules/orders/orders.export-visa-bundle.js';
import { exportMasterQuerySchema, exportTemplatesQuerySchema } from '../modules/orders/orders.schemas.js';
import { OrderService } from '../modules/orders/orders.service.js';
import { buildFinanceExportWorkbook } from '../modules/finances/finances.export.js';
import { ReceiptsService } from '../modules/receipts/receipts.service.js';
import { loadOrderOverpayTrails } from '../modules/payments/overpay-trail.js';
import { sendItineraryEmail } from '../lib/itinerary-email.js';
import { TravelersService } from '../modules/travelers/travelers.service.js';
import { collectHotelPassportGroups } from '../modules/hotel-control/hotel-control.passports.js';
import { FulfillmentService } from '../modules/fulfillment/fulfillment.service.js';

const client = recorder.client as unknown as PrismaClient;

/** 会把行读回来的 Prisma 方法（count / aggregate / groupBy / *Many 写入不回行，不在此列）。*/
const ROW_RETURNING_METHODS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'create',
  'update',
  'upsert',
  'delete',
]);

/** 委托名（orderItem）→ 模型名（OrderItem）。*/
function modelOf(delegateName: string): Parameters<typeof heavyColumnReads>[0] {
  return (delegateName.charAt(0).toUpperCase() + delegateName.slice(1)) as Parameters<typeof heavyColumnReads>[0];
}

/** 本轮捕获到的全部查询里，读回了哪些图片大字段（`委托.方法: 字段路径`）。*/
function heavyReadsSoFar(): string[] {
  return recorder.calls
    .filter((c) => ROW_RETURNING_METHODS.has(c.method))
    .flatMap((c) => heavyColumnReads(modelOf(c.model), c.args).map((p) => `${c.model}.${c.method}: ${p}`));
}

/** 取某个委托某个方法的全部调用参数（断言「那条查询确实发出去了」用，免得断言空转）。*/
function argsOf(model: string, method: string): Array<Record<string, unknown>> {
  return recorder.calls
    .filter((c) => c.model === model && c.method === method)
    .map((c) => (c.args ?? {}) as Record<string, unknown>);
}

/** 分批取数第一步只取 id：给一张单，让第二步（带 include 的实体查询）真的发出去。*/
function answerOrderIdPass(call: RecordedCall): unknown {
  const select = (call.args as { select?: Record<string, unknown> } | undefined)?.select;
  if (call.model === 'order' && call.method === 'findMany' && select?.id === true && Object.keys(select).length === 1) {
    return [{ id: 'o1' }];
  }
  return undefined;
}

beforeEach(() => {
  recorder.reset();
});

// ── 1. 尺子本身 ─────────────────────────────────────────────────────────────
describe('heavyColumnReads — 口径', () => {
  it('只管三列：乘客护照照片、收款凭证、进账凭证', () => {
    expect(HEAVY_COLUMNS).toEqual({
      Passenger: ['passportPhotoUrl'],
      Payment: ['proofUrl'],
      Receipt: ['proofUrl'],
    });
  });

  it('不带 select / omit 的整行读 = 读图；omit 掉就不读', () => {
    expect(heavyColumnReads('Passenger', {})).toEqual(['passportPhotoUrl']);
    expect(heavyColumnReads('Passenger', { where: { orderId: 'o1' } })).toEqual(['passportPhotoUrl']);
    expect(heavyColumnReads('Passenger', { omit: PASSENGER_PHOTO_OMIT })).toEqual([]);
    expect(heavyColumnReads('Payment', { omit: PAYMENT_PROOF_OMIT })).toEqual([]);
    expect(heavyColumnReads('Receipt', { omit: RECEIPT_PROOF_OMIT, include: { allocations: true } })).toEqual([]);
    // omit 别的列不算数
    expect(heavyColumnReads('Receipt', { omit: { payerNote: true } })).toEqual(['proofUrl']);
  });

  it('select：只看点名的列 —— 点了图就算读，没点就不读', () => {
    expect(heavyColumnReads('Passenger', { select: { id: true, fullName: true } })).toEqual([]);
    expect(heavyColumnReads('Passenger', { select: { id: true, passportPhotoUrl: true } })).toEqual([
      'passportPhotoUrl',
    ]);
    expect(heavyColumnReads('Passenger', { select: { passportPhotoUrl: false } })).toEqual([]);
  });

  it('关系 include：`rel: true` 等于目标整行；片段 PASSENGERS_WITHOUT_PHOTO / PAYMENTS_WITHOUT_PROOF 不读', () => {
    expect(heavyColumnReads('Order', { include: { passengers: true, payments: true, refunds: true } })).toEqual([
      'passengers.passportPhotoUrl',
      'payments.proofUrl',
    ]);
    expect(
      heavyColumnReads('Order', {
        include: { passengers: PASSENGERS_WITHOUT_PHOTO, payments: PAYMENTS_WITHOUT_PROOF, refunds: true },
      }),
    ).toEqual([]);
    // 关系上只写 where / orderBy 不写 omit，照样是整行
    expect(heavyColumnReads('Order', { include: { passengers: { where: { visaExempt: false } } } })).toEqual([
      'passengers.passportPhotoUrl',
    ]);
  });

  it('嵌套关系与 select 里的关系都跟进去；_count 之类不是关系、不算读', () => {
    expect(heavyColumnReads('OrderItem', { include: { order: { include: { passengers: true } } } })).toEqual([
      'order.passengers.passportPhotoUrl',
    ]);
    expect(
      heavyColumnReads('OrderItem', { include: { order: { select: { passengers: { select: { id: true } } } } } }),
    ).toEqual([]);
    expect(
      heavyColumnReads('Order', {
        select: { id: true, _count: { select: { passengers: true } }, payments: { select: { status: true } } },
      }),
    ).toEqual([]);
    // 收款整行 + 其订单整行：订单本身没有图片列，只算收款那一列
    expect(heavyColumnReads('Payment', { include: { order: true } })).toEqual(['proofUrl']);
  });
});

// ── 2. 不需要字节的读路径 ─────────────────────────────────────────────────────
describe('导出不读图片大字段', () => {
  const month = { from: '2026-08-25', to: '2026-09-24' };

  it('全岗总表：分批取实体那一步乘客 / 收款都 omit 掉图片列，整轮查询一列图都不读', async () => {
    recorder.respondWith(answerOrderIdPass);
    await buildMasterExportWorkbook(exportMasterQuerySchema.parse({ ...month, role: 'all' }), client, {
      agentScope: null,
    });
    const entityPass = argsOf('order', 'findMany').find((a) => a.include);
    expect(entityPass?.include).toMatchObject({
      passengers: PASSENGERS_WITHOUT_PHOTO,
      payments: PAYMENTS_WITHOUT_PROOF,
    });
    expect(heavyReadsSoFar()).toEqual([]);
  });

  it.each(['full', 'ticketing', 'visa'] as const)('三模板《%s》：同上', async (template) => {
    recorder.respondWith(answerOrderIdPass);
    await buildOrderTemplateExportWorkbook(exportTemplatesQuerySchema.parse({ ...month, template }), client, {
      agentScope: null,
    });
    const entityPass = argsOf('order', 'findMany').find((a) => a.include);
    expect(entityPass?.include).toMatchObject({
      passengers: PASSENGERS_WITHOUT_PHOTO,
      payments: PAYMENTS_WITHOUT_PROOF,
    });
    expect(heavyReadsSoFar()).toEqual([]);
  });

  it.each([
    ['入住日区间', { from: '2026-10-01', to: '2026-10-14' }],
    ['出发日', { departDate: '2026-10-10' }],
  ] as const)('分房表（%s）：占房行联查订单时乘客不读护照照片', async (_label, params) => {
    await buildRoomAllocationWorkbook(params, client);
    const [itemQuery] = argsOf('orderItem', 'findMany');
    expect(itemQuery?.include).toMatchObject({ order: { include: { passengers: PASSENGERS_WITHOUT_PHOTO } } });
    expect(heavyReadsSoFar()).toEqual([]);
  });

  it('整班机导出：乘客不读护照照片', async () => {
    await buildOrdersBySchedule('sched-1', client);
    const entityQuery = argsOf('order', 'findMany').find((a) => a.include);
    expect(entityQuery?.include).toMatchObject({ passengers: PASSENGERS_WITHOUT_PHOTO });
    expect(heavyReadsSoFar()).toEqual([]);
  });

  it('财务明细导出：乘客不读护照照片', async () => {
    await buildFinanceExportWorkbook(month, client);
    const [orderQuery] = argsOf('order', 'findMany');
    expect(orderQuery?.include).toMatchObject({ passengers: PASSENGERS_WITHOUT_PHOTO });
    expect(heavyReadsSoFar()).toEqual([]);
  });
});

describe('对账不读凭证图', () => {
  it('总账：进账与收款两边都不读凭证图', async () => {
    await new ReceiptsService().ledger();
    expect(argsOf('receipt', 'findMany')[0]).toMatchObject({ omit: RECEIPT_PROOF_OMIT });
    expect(argsOf('payment', 'findMany')[0]).toMatchObject({ omit: PAYMENT_PROOF_OMIT });
    expect(heavyReadsSoFar()).toEqual([]);
  });

  it('流水核对表导出：翻页取进账不读凭证图', async () => {
    await new ReceiptsService().exportStatement({});
    expect(argsOf('receipt', 'findMany')[0]).toMatchObject({ omit: RECEIPT_PROOF_OMIT });
    expect(heavyReadsSoFar()).toEqual([]);
  });

  it('订单详情挂账去向：查池子进账不读凭证图', async () => {
    await loadOrderOverpayTrails('o1', []);
    expect(argsOf('receipt', 'findMany')[0]).toMatchObject({ omit: RECEIPT_PROOF_OMIT });
    expect(heavyReadsSoFar()).toEqual([]);
  });
});

describe('行程单 / 常旅客历史不读护照照片', () => {
  it('行程单邮件与行程单下载：乘客不读护照照片', async () => {
    await expect(sendItineraryEmail('o1')).resolves.toEqual({ status: 'no_email' });
    await expect(
      new OrderService().getOrderItineraryData('o1', { userId: 'u1', role: 'ADMIN' }),
    ).rejects.toThrow('订单不存在');
    const queries = argsOf('order', 'findUnique');
    expect(queries).toHaveLength(2);
    for (const q of queries) expect(q.include).toMatchObject({ passengers: PASSENGERS_WITHOUT_PHOTO });
    expect(heavyReadsSoFar()).toEqual([]);
  });

  it('常旅客历史行程：按姓名 + 生日捞的每一趟乘客行都不读护照照片', async () => {
    recorder.respondWith((call) =>
      call.model === 'savedPassenger' && call.method === 'findUnique'
        ? { id: 'sp1', userId: null, user: null, fullName: 'ZHANG SAN', dateOfBirth: new Date('1990-01-01') }
        : undefined,
    );
    await new TravelersService().getById('sp1');
    expect(argsOf('passenger', 'findMany')[0]).toMatchObject({ omit: PASSENGER_PHOTO_OMIT });
    expect(heavyReadsSoFar()).toEqual([]);
  });
});

// ── 3. 对照组：要字节的路径照旧整列读 ─────────────────────────────────────────
describe('对照：要照片字节的路径不受影响', () => {
  it('签证资料包取数（护照包要图）照旧读乘客护照照片', async () => {
    recorder.respondWith(answerOrderIdPass);
    await queryOrdersByIdsForVisa(['o1'], client);
    expect(heavyReadsSoFar()).toContain('order.findMany: passengers.passportPhotoUrl');
  });

  it('房控酒店护照包照旧读护照照片', async () => {
    await collectHotelPassportGroups({ hotelId: 'h1', from: '2026-10-01', to: '2026-10-02' }, client);
    expect(heavyReadsSoFar()).toContain('orderItem.findMany: order.passengers.passportPhotoUrl');
  });

  it('签证台按单取图照旧读护照照片', async () => {
    await new FulfillmentService().listPassengerPhotos('o1');
    expect(heavyReadsSoFar()).toEqual(['passenger.findMany: passportPhotoUrl']);
  });
});
