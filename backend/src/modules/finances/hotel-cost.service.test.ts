/**
 * 酒店房型净房价按日期区间 · 单测（vitest，不依赖真 DB）
 *
 * 覆盖：
 *   1. 逐晚取价：区间价优先 → 缺省价 → 都没有 null；含边界日（effectiveFrom / effectiveTo 当晚都算）。
 *   2. 一段住宿：跨区间累加 × 房数；任一晚缺价整体 null；无日期回退缺省价 × 晚数。
 *   3. 平均每间每晚（供沿用 unit × 晚数 × 房数 公式的快照点）。
 *   4. 时区边界：@db.Date 出来的 UTC 零点 Date 按 UTC 日历日比较，不折本地时区。
 *   5. 区间写入：开事务 → 锁房型行 → 查重叠 → 写；重叠抛 409 ConflictError 且不写入；from > to 拒。
 */
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';

vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import { ConflictError, NotFoundError } from '../../lib/errors.js';
import {
  createHotelRoomTypeCostPeriod,
  deleteHotelRoomTypeCostPeriod,
  expandStayNights,
  hotelCostPeriodsOverlap,
  hotelStayCostCny,
  loadHotelCostPeriodsByRoomTypeIds,
  resolveHotelNightCostCny,
  resolveHotelStayUnitCostCny,
  updateHotelRoomTypeCostPeriod,
} from './hotel-cost.service.js';

const PEAK = { effectiveFrom: '2026-10-01', effectiveTo: '2026-10-07', costPriceCny: 900 };
const WEEKEND = {
  effectiveFrom: new Date('2026-09-26T00:00:00.000Z'),
  effectiveTo: new Date('2026-09-27T00:00:00.000Z'),
  costPriceCny: new Prisma.Decimal('650.50'),
};

describe('resolveHotelNightCostCny · 某一晚取价', () => {
  it('覆盖该晚的区间 → 区间价（Decimal 也能喂）', () => {
    expect(resolveHotelNightCostCny([PEAK, WEEKEND], 400, '2026-10-03')).toBe(900);
    expect(resolveHotelNightCostCny([PEAK, WEEKEND], 400, new Date('2026-09-26T00:00:00.000Z'))).toBe(650.5);
  });

  it('边界日：effectiveFrom 当晚和 effectiveTo 当晚都算区间内', () => {
    expect(resolveHotelNightCostCny([PEAK], 400, '2026-10-01')).toBe(900);
    expect(resolveHotelNightCostCny([PEAK], 400, '2026-10-07')).toBe(900);
    expect(resolveHotelNightCostCny([PEAK], 400, '2026-09-30')).toBe(400);
    expect(resolveHotelNightCostCny([PEAK], 400, '2026-10-08')).toBe(400);
  });

  it('没被区间覆盖 → 房型缺省价；缺省价也没有 → null（不落 0）', () => {
    expect(resolveHotelNightCostCny([PEAK], 400, '2026-11-11')).toBe(400);
    expect(resolveHotelNightCostCny([PEAK], null, '2026-11-11')).toBeNull();
    expect(resolveHotelNightCostCny(undefined, undefined, '2026-11-11')).toBeNull();
  });

  it('缺省价为 0 是有效成本（不等同缺失）', () => {
    expect(resolveHotelNightCostCny([], 0, '2026-11-11')).toBe(0);
  });

  it('时区边界：UTC 零点 Date 按 UTC 日历日比较，北京时间 10-01 00:00（UTC 09-30 16:00）不算 10-01', () => {
    // @db.Date 经 Prisma 出来永远是 UTC 零点，这是唯一被支持的 Date 形态
    expect(resolveHotelNightCostCny([PEAK], 400, new Date('2026-10-01T00:00:00.000Z'))).toBe(900);
    // 非零点 Date（不该出现）按其 UTC 日历日处理，不会被本地时区折成另一天
    expect(resolveHotelNightCostCny([PEAK], 400, new Date('2026-09-30T16:00:00.000Z'))).toBe(400);
    expect(resolveHotelNightCostCny([PEAK], 400, new Date('2026-10-07T23:59:59.000Z'))).toBe(900);
  });
});

describe('expandStayNights · 住宿区间逐晚展开', () => {
  it('[checkIn, checkOut) 半开：3 晚', () => {
    expect(expandStayNights('2026-09-30', '2026-10-03')).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
  });

  it('退房 ≤ 入住 → null（调用方走无日期回退）', () => {
    expect(expandStayNights('2026-10-03', '2026-10-03')).toBeNull();
    expect(expandStayNights('2026-10-03', '2026-10-01')).toBeNull();
  });
});

describe('hotelStayCostCny · 一段住宿合计', () => {
  it('跨区间入住：区间内的晚按区间价、区间外的晚按缺省价，逐晚累加 × 房数', () => {
    // 09-30(400) + 10-01(900) + 10-02(900) = 2200；× 2 间 = 4400
    expect(
      hotelStayCostCny({ periods: [PEAK], baseCostCny: 400, checkIn: '2026-09-30', checkOut: '2026-10-03', rooms: 2 }),
    ).toBe(4400);
  });

  it('退房日当晚不算（半开区间）：10-07 退房 → 10-07 不计', () => {
    // 10-06(900) 一晚
    expect(hotelStayCostCny({ periods: [PEAK], baseCostCny: 400, checkIn: '2026-10-06', checkOut: '2026-10-07' })).toBe(900);
  });

  it('0.5 间（拼房口径）× 逐晚合计，保留两位小数', () => {
    // 09-26(650.5) + 09-27(650.5) = 1301 × 0.5 = 650.5
    expect(
      hotelStayCostCny({ periods: [WEEKEND], baseCostCny: null, checkIn: '2026-09-26', checkOut: '2026-09-28', rooms: 0.5 }),
    ).toBe(650.5);
  });

  it('任一晚取不到价（缺省价为空且区间没覆盖）→ 整体 null，不落 0', () => {
    expect(
      hotelStayCostCny({ periods: [PEAK], baseCostCny: null, checkIn: '2026-09-30', checkOut: '2026-10-03' }),
    ).toBeNull();
  });

  it('区间把整段住宿全覆盖时，缺省价为空也能算', () => {
    expect(hotelStayCostCny({ periods: [PEAK], baseCostCny: null, checkIn: '2026-10-01', checkOut: '2026-10-04' })).toBe(2700);
  });

  it('无入住日期 → 回退缺省价 × nights × rooms（原逻辑）；缺省价空 → null', () => {
    expect(hotelStayCostCny({ periods: [PEAK], baseCostCny: 400, nights: 3, rooms: 2 })).toBe(2400);
    expect(hotelStayCostCny({ periods: [PEAK], baseCostCny: 400 })).toBe(400);
    expect(hotelStayCostCny({ periods: [PEAK], baseCostCny: null, nights: 3 })).toBeNull();
  });

  it('入住/退房是 UTC 零点 Date（@db.Date 形态）时与字符串同结果', () => {
    expect(
      hotelStayCostCny({
        periods: [PEAK],
        baseCostCny: 400,
        checkIn: new Date('2026-09-30T00:00:00.000Z'),
        checkOut: new Date('2026-10-03T00:00:00.000Z'),
      }),
    ).toBe(2200);
  });
});

describe('resolveHotelStayUnitCostCny · 平均每间每晚', () => {
  it('有日期 → 逐晚合计 ÷ 晚数（两位小数）；乘回晚数与逐晚合计一致', () => {
    // (400 + 900 + 900) / 3 = 733.33
    expect(resolveHotelStayUnitCostCny({ periods: [PEAK], baseCostCny: 400, checkIn: '2026-09-30', checkOut: '2026-10-03' })).toBe(
      733.33,
    );
  });

  it('无日期 → 缺省价；缺省价空 → null；有日期但某晚缺价 → null', () => {
    expect(resolveHotelStayUnitCostCny({ periods: [PEAK], baseCostCny: 400 })).toBe(400);
    expect(resolveHotelStayUnitCostCny({ periods: [PEAK], baseCostCny: null })).toBeNull();
    expect(
      resolveHotelStayUnitCostCny({ periods: [PEAK], baseCostCny: null, checkIn: '2026-09-30', checkOut: '2026-10-03' }),
    ).toBeNull();
  });
});

describe('hotelCostPeriodsOverlap · 闭区间重叠判定', () => {
  it('首尾相接（同一天）算重叠；隔一天不算', () => {
    expect(hotelCostPeriodsOverlap(PEAK, { effectiveFrom: '2026-10-07', effectiveTo: '2026-10-10' })).toBe(true);
    expect(hotelCostPeriodsOverlap(PEAK, { effectiveFrom: '2026-10-08', effectiveTo: '2026-10-10' })).toBe(false);
    expect(hotelCostPeriodsOverlap(PEAK, { effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' })).toBe(false);
  });
});

describe('loadHotelCostPeriodsByRoomTypeIds · 批量取数', () => {
  it('空 id 列表不查库；有 id 时一次 findMany 按房型分组', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { roomTypeId: 'rt1', effectiveFrom: new Date('2026-10-01T00:00:00.000Z'), effectiveTo: new Date('2026-10-07T00:00:00.000Z'), costPriceCny: new Prisma.Decimal(900) },
      { roomTypeId: 'rt2', effectiveFrom: new Date('2026-10-01T00:00:00.000Z'), effectiveTo: new Date('2026-10-02T00:00:00.000Z'), costPriceCny: new Prisma.Decimal(500) },
    ]);
    const client = { hotelRoomTypeCostPeriod: { findMany } } as unknown as PrismaClient;

    const empty = await loadHotelCostPeriodsByRoomTypeIds([null, undefined, ''], client);
    expect(empty.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();

    const map = await loadHotelCostPeriodsByRoomTypeIds(['rt1', 'rt2', 'rt1', null], client);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]![0].where).toEqual({ roomTypeId: { in: ['rt1', 'rt2'] } });
    expect(map.get('rt1')).toHaveLength(1);
    expect(map.get('rt2')).toHaveLength(1);
  });
});

describe('区间写入 — 重叠校验在事务 + 房型行锁里做，冲突 409', () => {
  function periodRow() {
    return {
      id: 'hp1',
      roomTypeId: 'rt1',
      effectiveFrom: new Date('2026-10-01T00:00:00.000Z'),
      effectiveTo: new Date('2026-10-07T00:00:00.000Z'),
      costPriceCny: new Prisma.Decimal('900.00'),
      note: null,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    };
  }

  function txClient(overrides: { overlap?: unknown; existing?: unknown; locked?: Array<{ id: string }> } = {}) {
    const calls: string[] = [];
    const tx = {
      $queryRaw: vi.fn().mockImplementation(async () => {
        calls.push('lock');
        return overrides.locked ?? [{ id: 'rt1' }];
      }),
      hotelRoomTypeCostPeriod: {
        findFirst: vi.fn().mockImplementation(async () => {
          calls.push('overlap');
          return overrides.overlap ?? null;
        }),
        findUnique: vi.fn().mockImplementation(async () => overrides.existing ?? null),
        create: vi.fn().mockImplementation(async () => {
          calls.push('write');
          return periodRow();
        }),
        update: vi.fn().mockImplementation(async () => {
          calls.push('write');
          return periodRow();
        }),
      },
    };
    const client = {
      $transaction: vi.fn().mockImplementation(async (cb: (t: unknown) => unknown) => {
        calls.push('tx-begin');
        return cb(tx);
      }),
      hotelRoomTypeCostPeriod: {
        findFirst: vi.fn().mockRejectedValue(new Error('不该在事务外查重叠')),
        create: vi.fn().mockRejectedValue(new Error('不该在事务外写入')),
        update: vi.fn().mockRejectedValue(new Error('不该在事务外写入')),
        findUnique: vi.fn().mockRejectedValue(new Error('不该在事务外读')),
      },
    } as unknown as PrismaClient;
    return { client, tx, calls };
  }

  it('create：开事务 → 锁房型行 → 查重叠 → 写；回传 DTO 为 YYYY-MM-DD + number', async () => {
    const { client, calls, tx } = txClient();
    const dto = await createHotelRoomTypeCostPeriod(
      'rt1',
      { effectiveFrom: '2026-10-01', effectiveTo: '2026-10-07', costPriceCny: 900, note: '国庆' },
      client,
    );
    expect(calls).toEqual(['tx-begin', 'lock', 'overlap', 'write']);
    expect(dto).toMatchObject({ id: 'hp1', roomTypeId: 'rt1', effectiveFrom: '2026-10-01', effectiveTo: '2026-10-07', costPriceCny: 900 });
    // 写库的是 UTC 零点 Date（@db.Date 规范写法），不折时区
    const data = tx.hotelRoomTypeCostPeriod.create.mock.calls[0]![0].data;
    expect(data.effectiveFrom.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(data.effectiveTo.toISOString()).toBe('2026-10-07T00:00:00.000Z');
  });

  it('create：锁里查出重叠 → 抛 ConflictError(409)，消息带现有区间，且不写入', async () => {
    const { client, tx } = txClient({
      overlap: { id: 'hp0', effectiveFrom: new Date('2026-10-05T00:00:00.000Z'), effectiveTo: new Date('2026-10-10T00:00:00.000Z') },
    });
    const err = await createHotelRoomTypeCostPeriod(
      'rt1',
      { effectiveFrom: '2026-10-01', effectiveTo: '2026-10-07', costPriceCny: 900 },
      client,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    expect((err as Error).message).toContain('重叠');
    expect((err as Error).message).toContain('2026-10-05 → 2026-10-10');
    expect(tx.hotelRoomTypeCostPeriod.create).not.toHaveBeenCalled();
  });

  it('create：起始日晚于结束日 → 409 拒绝，不查重叠不写入', async () => {
    const { client, tx } = txClient();
    await expect(
      createHotelRoomTypeCostPeriod('rt1', { effectiveFrom: '2026-10-07', effectiveTo: '2026-10-01', costPriceCny: 900 }, client),
    ).rejects.toThrow('起始日不能晚于结束日');
    expect(tx.hotelRoomTypeCostPeriod.findFirst).not.toHaveBeenCalled();
    expect(tx.hotelRoomTypeCostPeriod.create).not.toHaveBeenCalled();
  });

  it('create：房型不存在（锁不到行）→ NotFoundError，不写入', async () => {
    const { client, tx } = txClient({ locked: [] });
    await expect(
      createHotelRoomTypeCostPeriod('rt-x', { effectiveFrom: '2026-10-01', effectiveTo: '2026-10-07', costPriceCny: 900 }, client),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(tx.hotelRoomTypeCostPeriod.create).not.toHaveBeenCalled();
  });

  it('update：改日期 → 锁房型行、锁里重读本行、查重叠（排除自己）、写', async () => {
    const { client, calls, tx } = txClient({ existing: periodRow() });
    await updateHotelRoomTypeCostPeriod('hp1', { effectiveTo: '2026-10-08' }, client);
    expect(calls).toEqual(['tx-begin', 'lock', 'overlap', 'write']);
    const where = tx.hotelRoomTypeCostPeriod.findFirst.mock.calls[0]![0].where;
    expect(where.roomTypeId).toBe('rt1');
    expect(where.NOT).toEqual({ id: 'hp1' });
  });

  it('update：只改价不改日期 → 不查重叠，直接写', async () => {
    const { client, calls } = txClient({ existing: periodRow() });
    await updateHotelRoomTypeCostPeriod('hp1', { costPriceCny: 950 }, client);
    expect(calls).toEqual(['tx-begin', 'lock', 'write']);
  });

  it('update：区间已被并发删掉（锁不到行）→ NotFoundError，不写库', async () => {
    const { client, tx } = txClient({ locked: [] });
    await expect(updateHotelRoomTypeCostPeriod('hp1', { effectiveTo: '2026-10-08' }, client)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(tx.hotelRoomTypeCostPeriod.update).not.toHaveBeenCalled();
  });

  it('delete：记录不存在（P2025）→ NotFoundError 而非 500；成功回传 id + roomTypeId', async () => {
    const p2025 = new Prisma.PrismaClientKnownRequestError('gone', { code: 'P2025', clientVersion: 'test' });
    const missing = { hotelRoomTypeCostPeriod: { delete: vi.fn().mockRejectedValue(p2025) } } as unknown as PrismaClient;
    await expect(deleteHotelRoomTypeCostPeriod('hp-x', missing)).rejects.toBeInstanceOf(NotFoundError);

    const ok = {
      hotelRoomTypeCostPeriod: { delete: vi.fn().mockResolvedValue({ id: 'hp1', roomTypeId: 'rt1' }) },
    } as unknown as PrismaClient;
    await expect(deleteHotelRoomTypeCostPeriod('hp1', ok)).resolves.toEqual({ id: 'hp1', roomTypeId: 'rt1' });
  });
});
