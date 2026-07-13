/**
 * 按酒店导出护照 zip · 单元测试（vitest）
 *
 * 注入 fake PrismaClient（collectHotelPassportGroups 支持 client 参数），覆盖：
 *   1. 取数过滤：酒店 + 入住区间 + 排除已取消/软删（COUNTED_STATUSES）落到 where
 *   2. 同订单多晚/多行只归并一次（去重）
 *   3. zip 结构：按订单号分文件夹 {orderNumber}/{LASTNAME}_{护照号}.{ext} + 根部 README.txt
 *   4. 缺护照图乘客写进 README，不进文件夹
 *   5. 空结果 / 全员无照片 → hasAnyPassportPhoto 判定（路由据此 400）
 *
 * 无图路径不触发 fetch(照片)，不 mock 网络；默认 prisma 不参与（全走注入 client）。
 */
import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';

// 默认 prisma 不参与（全部走注入 client）—— 仍需 mock 掉避免真实连接配置
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import type { PrismaClient } from '@prisma/client';
import {
  buildHotelPassportsZip,
  buildPassportsByNamesZip,
  collectHotelPassportGroups,
  collectPassportGroupsByNames,
  hasAnyPassportPhoto,
  type HotelPassportSelection,
  type HotelPassportsByNamesSelection,
} from './hotel-control.passports.js';

const D = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

/** 造一条占房 item（带 order + passengers），只填测试关心的字段。*/
function makeItem(opts: {
  orderId: string;
  orderNumber: string;
  hotelName?: string;
  checkIn?: string;
  passengers: Array<{
    id: string;
    fullName?: string;
    lastName?: string | null;
    firstName?: string | null;
    documentNumber: string;
    passportPhotoUrl?: string | null;
  }>;
}) {
  return {
    hotelCheckIn: D(opts.checkIn ?? '2026-08-01'),
    hotelRoomType: { hotel: { name: opts.hotelName ?? '美溪海滩酒店' } },
    order: {
      id: opts.orderId,
      orderNumber: opts.orderNumber,
      passengers: opts.passengers.map((p) => ({
        id: p.id,
        fullName: p.fullName ?? 'ZHANG SAN',
        lastName: p.lastName ?? null,
        firstName: p.firstName ?? null,
        documentNumber: p.documentNumber,
        passportPhotoUrl: p.passportPhotoUrl ?? null,
      })),
    },
  };
}

function fakeClient(items: unknown[]): PrismaClient {
  return {
    orderItem: { findMany: vi.fn().mockResolvedValue(items) },
  } as unknown as PrismaClient;
}

describe('collectHotelPassportGroups — 取数过滤', () => {
  it('where 命中：酒店 + hotelCheckIn 区间 + 占房行 + 排除取消/软删', async () => {
    const client = fakeClient([]);
    await collectHotelPassportGroups({ hotelId: 'h9', from: '2026-08-01', to: '2026-08-10' }, client);
    const findMany = client.orderItem.findMany as unknown as ReturnType<typeof vi.fn>;
    const where = findMany.mock.calls[0][0].where;

    expect(where.hotelRoomTypeId).toEqual({ not: null });
    expect(where.hotelRoomType).toEqual({ hotelId: 'h9' });
    expect(where.hotelCheckIn).toEqual({
      gte: D('2026-08-01'),
      lte: D('2026-08-10'),
    });
    expect(where.order.deletedAt).toBeNull();
    expect(where.order.status.in).toContain('PAID');
    expect(where.order.status.in).not.toContain('CANCELLED');
  });

  it('同订单多晚/多行只归并一次；hotelName 取自命中行', async () => {
    const client = fakeClient([
      makeItem({
        orderId: 'o1',
        orderNumber: 'FTM2026080100001',
        checkIn: '2026-08-01',
        passengers: [{ id: 'p1', documentNumber: 'E1' }],
      }),
      // 同订单第二晚 / 第二行 → 不应重复归并
      makeItem({
        orderId: 'o1',
        orderNumber: 'FTM2026080100001',
        checkIn: '2026-08-02',
        passengers: [{ id: 'p1', documentNumber: 'E1' }],
      }),
    ]);
    const sel = await collectHotelPassportGroups(
      { hotelId: 'h1', from: '2026-08-01', to: '2026-08-10' },
      client,
    );
    expect(sel.groups).toHaveLength(1);
    expect(sel.groups[0].orderNumber).toBe('FTM2026080100001');
    expect(sel.hotelName).toBe('美溪海滩酒店');
  });
});

describe('hasAnyPassportPhoto', () => {
  it('全员无照片 → false；任一有图 → true', () => {
    expect(
      hasAnyPassportPhoto([
        {
          orderNumber: 'A',
          passengers: [{ id: 'p', fullName: '', lastName: null, firstName: null, documentNumber: 'E1', passportPhotoUrl: null }],
        },
      ]),
    ).toBe(false);
    expect(
      hasAnyPassportPhoto([
        {
          orderNumber: 'A',
          passengers: [{ id: 'p', fullName: '', lastName: null, firstName: null, documentNumber: 'E1', passportPhotoUrl: 'https://x/y.jpg' }],
        },
      ]),
    ).toBe(true);
  });

  it('空结果 → false', () => {
    expect(hasAnyPassportPhoto([])).toBe(false);
  });
});

/** 列出 zip 内所有条目路径。*/
async function zipPaths(buf: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf);
  return Object.keys(zip.files);
}

async function readText(buf: Buffer, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file(path);
  expect(entry, `${path} 应存在`).not.toBeNull();
  return entry!.async('string');
}

describe('buildHotelPassportsZip — zip 结构', () => {
  it('有图乘客进 {订单号}/{LASTNAME}_{护照号}.ext；缺图乘客写 README，不进文件夹', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const selection: HotelPassportSelection = {
      hotelName: '美溪海滩酒店',
      groups: [
        {
          orderNumber: 'FTM2026080100001',
          passengers: [
            { id: 'p1', fullName: 'ZHANG SAN', lastName: 'ZHANG', firstName: 'SAN', documentNumber: 'E1', passportPhotoUrl: 'https://x/a.jpg' },
            { id: 'p2', fullName: 'LI SI', lastName: null, firstName: null, documentNumber: 'E2', passportPhotoUrl: null },
          ],
        },
      ],
    };

    const { buf, photoCount } = await buildHotelPassportsZip(selection, {
      hotelId: 'h1',
      from: '2026-08-01',
      to: '2026-08-10',
    });

    expect(photoCount).toBe(1);
    const paths = await zipPaths(buf);
    expect(paths).toContain('FTM2026080100001/ZHANG_E1.jpg');
    expect(paths).toContain('README.txt');
    // 缺图乘客不落文件
    expect(paths.some((p) => p.includes('E2'))).toBe(false);

    const readme = await readText(buf, 'README.txt');
    expect(readme).toContain('FTM2026080100001');
    expect(readme).toContain('LI_E2'); // 缺图乘客在 README 里点名（LASTNAME 从 fullName 拆出）
    expect(readme).toContain('没传护照照片');

    fetchSpy.mockRestore();
  });

  it('下载失败的乘客计入 README（不计 photoCount）', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 500 }));

    const selection: HotelPassportSelection = {
      hotelName: '美溪海滩酒店',
      groups: [
        {
          orderNumber: 'FTM2026080100002',
          passengers: [
            { id: 'p1', fullName: 'WANG WU', lastName: 'WANG', firstName: 'WU', documentNumber: 'E9', passportPhotoUrl: 'https://x/fail.jpg' },
          ],
        },
      ],
    };

    const { buf, photoCount } = await buildHotelPassportsZip(selection, {
      hotelId: 'h1',
      from: '2026-08-01',
      to: '2026-08-10',
    });

    expect(photoCount).toBe(0);
    const readme = await readText(buf, 'README.txt');
    expect(readme).toContain('下载失败');

    fetchSpy.mockRestore();
  });
});

// ── 按姓名批量导出 ──────────────────────────────────────────────────────

function fakePassengerClient(passengers: unknown[]): PrismaClient {
  return {
    passenger: { findMany: vi.fn().mockResolvedValue(passengers) },
  } as unknown as PrismaClient;
}

/** 造一条命中乘客（带 order），只填测试关心的字段。*/
function makePassenger(opts: {
  id: string;
  orderId: string;
  orderNumber: string;
  fullName?: string;
  lastName?: string | null;
  firstName?: string | null;
  chineseName?: string | null;
  documentNumber: string;
  passportPhotoUrl?: string | null;
}) {
  return {
    id: opts.id,
    fullName: opts.fullName ?? 'ZHANG SAN',
    lastName: opts.lastName ?? null,
    firstName: opts.firstName ?? null,
    chineseName: opts.chineseName ?? null,
    documentNumber: opts.documentNumber,
    passportPhotoUrl: opts.passportPhotoUrl ?? null,
    order: { id: opts.orderId, orderNumber: opts.orderNumber },
  };
}

describe('collectPassportGroupsByNames — 取数过滤', () => {
  it('where 命中：排除取消/软删；姓名去重后各自构造 OR（fullName 不敏感 + chineseName 精确）', async () => {
    const client = fakePassengerClient([]);
    await collectPassportGroupsByNames(['张三', ' ZHANG SAN '], client);
    const findMany = client.passenger.findMany as unknown as ReturnType<typeof vi.fn>;
    const where = findMany.mock.calls[0][0].where;

    expect(where.order.deletedAt).toBeNull();
    expect(where.order.status.in).toContain('PAID');
    expect(where.order.status.in).not.toContain('CANCELLED');
    expect(where.OR).toHaveLength(2);
    expect(where.OR[1].OR).toEqual([
      { fullName: { equals: 'ZHANG SAN', mode: 'insensitive' } },
      { chineseName: 'ZHANG SAN' },
    ]);
  });

  it('姓名去重去空白：重复/纯空白项只查一次', async () => {
    const client = fakePassengerClient([]);
    await collectPassportGroupsByNames(['张三', '张三', '  ', ' 张三 '], client);
    const findMany = client.passenger.findMany as unknown as ReturnType<typeof vi.fn>;
    const where = findMany.mock.calls[0][0].where;
    expect(where.OR).toHaveLength(1);
  });

  it('全部为空白 → 不查库，直接返回空结果', async () => {
    const client = fakePassengerClient([]);
    const sel = await collectPassportGroupsByNames(['  ', ''], client);
    const findMany = client.passenger.findMany as unknown as ReturnType<typeof vi.fn>;
    expect(findMany).not.toHaveBeenCalled();
    expect(sel).toEqual({ groups: [], notFoundNames: [] });
  });

  it('fullName 大小写不敏感命中 + chineseName 精确 trim 命中', async () => {
    const client = fakePassengerClient([
      makePassenger({ id: 'p1', orderId: 'o1', orderNumber: 'FTM2026080100001', fullName: 'zhang san', documentNumber: 'E1' }),
      makePassenger({ id: 'p2', orderId: 'o2', orderNumber: 'FTM2026080100002', fullName: 'LI SI', chineseName: '李四', documentNumber: 'E2' }),
    ]);
    const sel = await collectPassportGroupsByNames(['ZHANG SAN', '李四'], client);
    expect(sel.notFoundNames).toEqual([]);
    expect(sel.groups).toHaveLength(2);
    expect(sel.groups.map((g) => g.orderNumber).sort()).toEqual([
      'FTM2026080100001',
      'FTM2026080100002',
    ]);
  });

  it('未命中的姓名单独列出（保持输入顺序，去重）', async () => {
    const client = fakePassengerClient([
      makePassenger({ id: 'p1', orderId: 'o1', orderNumber: 'FTM2026080100001', fullName: 'ZHANG SAN', documentNumber: 'E1' }),
    ]);
    const sel = await collectPassportGroupsByNames(['张三', '李四', '王五'], client);
    expect(sel.notFoundNames).toEqual(['张三', '李四', '王五']);
  });

  it('同名同证件号跨订单命中多单：全部打包，按订单分组（现有结构天然消歧）', async () => {
    const client = fakePassengerClient([
      makePassenger({ id: 'p1', orderId: 'o1', orderNumber: 'FTM2026080100001', fullName: 'ZHANG SAN', documentNumber: 'E1' }),
      makePassenger({ id: 'p2', orderId: 'o2', orderNumber: 'FTM2026080100002', fullName: 'ZHANG SAN', documentNumber: 'E1' }),
    ]);
    const sel = await collectPassportGroupsByNames(['ZHANG SAN'], client);
    expect(sel.notFoundNames).toEqual([]);
    expect(sel.groups).toHaveLength(2);
    expect(sel.groups.map((g) => g.orderNumber).sort()).toEqual([
      'FTM2026080100001',
      'FTM2026080100002',
    ]);
  });
});

describe('buildPassportsByNamesZip — zip 结构', () => {
  it('结构与按酒店导出一致；README 额外追加未命中姓名段落', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const selection: HotelPassportsByNamesSelection = {
      groups: [
        {
          orderNumber: 'FTM2026080100001',
          passengers: [
            { id: 'p1', fullName: 'ZHANG SAN', lastName: 'ZHANG', firstName: 'SAN', documentNumber: 'E1', passportPhotoUrl: 'https://x/a.jpg' },
          ],
        },
      ],
      notFoundNames: ['李四', '王五'],
    };

    const { buf, photoCount } = await buildPassportsByNamesZip(selection);

    expect(photoCount).toBe(1);
    const paths = await zipPaths(buf);
    expect(paths).toContain('FTM2026080100001/ZHANG_E1.jpg');
    expect(paths).toContain('README.txt');

    const readme = await readText(buf, 'README.txt');
    expect(readme).toContain('以下姓名未找到任何客人');
    expect(readme).toContain('李四');
    expect(readme).toContain('王五');

    fetchSpy.mockRestore();
  });

  it('无未命中姓名时不追加该段落', async () => {
    const selection: HotelPassportsByNamesSelection = {
      groups: [],
      notFoundNames: [],
    };
    const { buf } = await buildPassportsByNamesZip(selection);
    const readme = await readText(buf, 'README.txt');
    expect(readme).not.toContain('未找到任何客人');
  });
});
