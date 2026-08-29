/**
 * 录单选了「不需要签证」→ 服务端不建签证任务 · 服务级测试（vitest）
 *
 * 背景（签证岗实测）：套餐含签证组件的单，录单把签证状态选成「不需要」，签证台照样挂一条
 * 「办理:待处理」。根因是这层保证此前只活在录单弹窗的前端联动里（选「不需要」时把出行人批量
 * 置自备签），联动只在下拉 onChange 那一瞬生效，任何错过它的时序（先改签证状态、后挑具体套餐；
 * 别的下单入口）都会漏；服务端建任务只看「商品级涉签」，含签证组件的套餐 hasVisaScope 恒为 true。
 *
 * 收口口径（visa-need.ts）：订单级 visaStatus=NOT_NEEDED 一票否决商品级涉签。
 * 乘客级 visaExempt 一概不碰 —— 它同时是定价输入（自备签减免 / 签证组件按办签人数计费），
 * 服务端替客人勾自备签就是静默改价。
 *
 * 覆盖两条建任务路径（第三条 syncVisaTasksForOrder 见 orders.visa-task-sync.test.ts）：
 *   1. 下单即建 createVisaTaskAtCreation（未付款也要进签证台的那条）
 *   2. PAID 履约生成 createFulfillmentTasks（套餐 fan-out 到各岗）
 */
import { describe, it, expect, vi } from 'vitest';
import { VisaRequirement } from '@prisma/client';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    order: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    orderItem: { findMany: vi.fn() },
    passenger: { findMany: vi.fn() },
    bundle: { findUnique: vi.fn() },
    fulfillmentTask: { updateMany: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../db/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../lib/audit.js', () => ({
  writeAudit: vi.fn(),
  actorFromRequest: vi.fn(() => ({})),
}));

import { createVisaTaskAtCreation, createFulfillmentTasks } from './orders.service.js';

interface StubItem {
  id: string;
  kind: string;
  bundleId?: string | null;
  tasks?: Array<{ type: string; status?: string }>;
}

/**
 * 可控的假事务客户端：订单级签证状态 / 订单项（含既有任务）/ 乘客自备签 / 套餐组件。
 * `created` 记下所有落库的任务，断言直接看它。
 */
function makeTx(opts: {
  visaStatus?: VisaRequirement | null;
  items: StubItem[];
  passengers?: Array<{ visaExempt: boolean }>;
  bundleItems?: Array<{ kind: string }> | null;
}) {
  const created: Array<{ orderItemId: string; type: string; status: string }> = [];
  let seq = 0;
  const tx = {
    order: {
      findUnique: vi.fn().mockResolvedValue({ visaStatus: opts.visaStatus ?? null }),
    },
    orderItem: {
      findMany: vi.fn().mockResolvedValue(
        opts.items.map((it) => ({
          id: it.id,
          kind: it.kind,
          bundleId: it.bundleId ?? null,
          fulfillmentTasks: (it.tasks ?? []).map((t) => ({
            type: t.type,
            status: t.status ?? 'PENDING',
          })),
        })),
      ),
    },
    passenger: {
      // 缺省：两位都随团办签（没人被置自备签）—— 正是漏建那一单的现场
      findMany: vi
        .fn()
        .mockResolvedValue(opts.passengers ?? [{ visaExempt: false }, { visaExempt: false }]),
    },
    bundle: {
      findUnique: vi
        .fn()
        .mockResolvedValue(opts.bundleItems === null ? null : { items: opts.bundleItems ?? [] }),
    },
    fulfillmentTask: {
      create: vi.fn().mockImplementation(
        async ({ data }: { data: { orderItemId: string; type: string; status: string } }) => {
          created.push(data);
          return { id: `task_${++seq}`, ...data };
        },
      ),
    },
  };
  return { tx, created };
}

/** 含签证组件的套餐单（机票另落 FLIGHT 行，故这里只有套餐行）。 */
const bundleWithVisa = (visaStatus: VisaRequirement | null) => ({
  visaStatus,
  items: [{ id: 'itm_bundle', kind: 'BUNDLE', bundleId: 'bdl_visa' }],
  bundleItems: [{ kind: 'FLIGHT' }, { kind: 'HOTEL' }, { kind: 'VISA' }],
});

describe('createVisaTaskAtCreation · 订单级「不需要签证」一票否决', () => {
  const run = async (tx: unknown) =>
    createVisaTaskAtCreation(tx as Parameters<typeof createVisaTaskAtCreation>[0], 'ord1');

  it('含签证组件的套餐 + 签证状态「不需要」+ 乘客都没置自备签 → 不建任务', async () => {
    const { tx, created } = makeTx(bundleWithVisa(VisaRequirement.NOT_NEEDED));
    const ids = await run(tx);
    expect(ids).toEqual([]);
    expect(created).toEqual([]);
    expect(tx.fulfillmentTask.create).not.toHaveBeenCalled();
  });

  it('纯签证行 + 签证状态「不需要」→ 同样不建', async () => {
    const { tx, created } = makeTx({
      visaStatus: VisaRequirement.NOT_NEEDED,
      items: [{ id: 'itm_visa', kind: 'VISA' }],
    });
    expect(await run(tx)).toEqual([]);
    expect(created).toEqual([]);
  });

  it('回归：同一张套餐单签证状态「需要」→ 照建待处理任务（锚点=套餐行）', async () => {
    const { tx, created } = makeTx(bundleWithVisa(VisaRequirement.NEEDED));
    const ids = await run(tx);
    expect(ids).toHaveLength(1);
    expect(created).toEqual([
      { orderItemId: 'itm_bundle', type: 'VISA_APPLICATION', status: 'PENDING' },
    ]);
  });

  it('回归：签证状态没表态（null）+ 含签证组件套餐 → 照建（没表态 ≠ 不需要，不漏单）', async () => {
    const { tx, created } = makeTx(bundleWithVisa(null));
    expect(await run(tx)).toHaveLength(1);
    expect(created.map((c) => c.type)).toEqual(['VISA_APPLICATION']);
  });
});

describe('createFulfillmentTasks · PAID 时套餐 fan-out 同样认订单级「不需要」', () => {
  const run = async (tx: unknown) =>
    createFulfillmentTasks(tx as Parameters<typeof createFulfillmentTasks>[0], 'ord1');

  it('套餐含签证组件 + 签证状态「不需要」→ 不 fan-out 签证任务，酒店任务不受影响', async () => {
    const { tx, created } = makeTx({
      visaStatus: VisaRequirement.NOT_NEEDED,
      items: [{ id: 'itm_bundle', kind: 'BUNDLE', bundleId: 'bdl_visa' }],
      bundleItems: [{ kind: 'HOTEL' }, { kind: 'VISA' }],
    });
    await run(tx);
    const types = created.map((c) => c.type);
    expect(types).not.toContain('VISA_APPLICATION');
    expect(types).toContain('HOTEL_BOOKING');
  });

  it('独立 VISA 行 + 签证状态「不需要」→ 不建签证任务', async () => {
    const { tx, created } = makeTx({
      visaStatus: VisaRequirement.NOT_NEEDED,
      items: [{ id: 'itm_visa', kind: 'VISA' }],
    });
    await run(tx);
    expect(created.map((c) => c.type)).not.toContain('VISA_APPLICATION');
  });

  it('回归：签证状态「需要」→ 签证 + 酒店任务都建', async () => {
    const { tx, created } = makeTx({
      visaStatus: VisaRequirement.NEEDED,
      items: [{ id: 'itm_bundle', kind: 'BUNDLE', bundleId: 'bdl_visa' }],
      bundleItems: [{ kind: 'HOTEL' }, { kind: 'VISA' }],
    });
    await run(tx);
    const types = created.map((c) => c.type);
    expect(types).toContain('VISA_APPLICATION');
    expect(types).toContain('HOTEL_BOOKING');
  });
});
