/**
 * 按酒店导出护照 zip · 单元测试（vitest）
 *
 * 注入 fake PrismaClient（collectHotelPassportGroups 支持 client 参数），覆盖：
 *   1. 取数过滤：酒店 + 入住区间 + 排除已取消/软删（COUNTED_STATUSES）落到 where
 *   2. 同订单多晚/多行只归并一次（去重）
 *   3. zip 结构：按订单号分文件夹 {orderNumber}/{LASTNAME}_{护照号}.{ext} + 根部 README.txt
 *   4. 缺护照图乘客写进 README，不进文件夹
 *   5. 空结果 / 全员无照片 → hasAnyPassportPhoto 判定（路由据此 400）
 *   6. 按姓名导出：出发日期过滤（出发地本地日口径）+ zip 按出发日期分文件夹、按姓名命名文件；
 *      按酒店导出结构保持不变（仍按订单号分文件夹，见第 3 点用例）
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
  passportsByNamesZipFilename,
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
  // data:image/... 走本地解码（护照图抓取的 SSRF 防线不出网），测试无需 mock 网络
  const PHOTO = 'data:image/jpeg;base64,AQID';

  it('有图乘客进 {订单号}/{LASTNAME}_{护照号}.ext；缺图乘客写 README，不进文件夹', async () => {
    const selection: HotelPassportSelection = {
      hotelName: '美溪海滩酒店',
      groups: [
        {
          orderNumber: 'FTM2026080100001',
          passengers: [
            { id: 'p1', fullName: 'ZHANG SAN', lastName: 'ZHANG', firstName: 'SAN', documentNumber: 'E1', passportPhotoUrl: PHOTO },
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

/**
 * 造一条命中乘客（带 order + 最早 FLIGHT 段），只填测试关心的字段。
 * departure 缺省 = 无航班订单（order.items 为空）。
 */
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
  departure?: { time: string; tz: string };
}) {
  return {
    id: opts.id,
    fullName: opts.fullName ?? 'ZHANG SAN',
    lastName: opts.lastName ?? null,
    firstName: opts.firstName ?? null,
    chineseName: opts.chineseName ?? null,
    documentNumber: opts.documentNumber,
    passportPhotoUrl: opts.passportPhotoUrl ?? null,
    order: {
      id: opts.orderId,
      orderNumber: opts.orderNumber,
      items: opts.departure
        ? [
            {
              flightSchedule: {
                departureTime: new Date(opts.departure.time),
                departureTz: opts.departure.tz,
              },
            },
          ]
        : [],
    },
  };
}

describe('collectPassportGroupsByNames — 取数过滤', () => {
  it('where 命中：排除取消/软删；姓名去重后各自构造 OR（fullName 不敏感 + chineseName 精确）；带出最早 FLIGHT 段', async () => {
    const client = fakePassengerClient([]);
    await collectPassportGroupsByNames({ names: ['张三', ' ZHANG SAN '] }, client);
    const findMany = client.passenger.findMany as unknown as ReturnType<typeof vi.fn>;
    const arg = findMany.mock.calls[0][0];
    const where = arg.where;

    expect(where.order.deletedAt).toBeNull();
    expect(where.order.status.in).toContain('PAID');
    expect(where.order.status.in).not.toContain('CANCELLED');
    expect(where.OR).toHaveLength(2);
    expect(where.OR[1].OR).toEqual([
      { fullName: { equals: 'ZHANG SAN', mode: 'insensitive' } },
      { chineseName: 'ZHANG SAN' },
    ]);

    // 出发日口径取数：每订单最早一段 FLIGHT 的 departureTime/departureTz
    const itemsSelect = arg.select.order.select.items;
    expect(itemsSelect.where.kind).toBe('FLIGHT');
    expect(itemsSelect.orderBy).toEqual({ flightSchedule: { departureTime: 'asc' } });
    expect(itemsSelect.take).toBe(1);
  });

  it('姓名去重去空白：重复/纯空白项只查一次', async () => {
    const client = fakePassengerClient([]);
    await collectPassportGroupsByNames({ names: ['张三', '张三', '  ', ' 张三 '] }, client);
    const findMany = client.passenger.findMany as unknown as ReturnType<typeof vi.fn>;
    const where = findMany.mock.calls[0][0].where;
    expect(where.OR).toHaveLength(1);
  });

  it('全部为空白 → 不查库，直接返回空结果', async () => {
    const client = fakePassengerClient([]);
    const sel = await collectPassportGroupsByNames({ names: ['  ', ''] }, client);
    const findMany = client.passenger.findMany as unknown as ReturnType<typeof vi.fn>;
    expect(findMany).not.toHaveBeenCalled();
    expect(sel).toEqual({ groups: [], notFoundNames: [] });
  });

  it('fullName 大小写不敏感命中 + chineseName 精确 trim 命中', async () => {
    const client = fakePassengerClient([
      makePassenger({ id: 'p1', orderId: 'o1', orderNumber: 'FTM2026080100001', fullName: 'zhang san', documentNumber: 'E1' }),
      makePassenger({ id: 'p2', orderId: 'o2', orderNumber: 'FTM2026080100002', fullName: 'LI SI', chineseName: '李四', documentNumber: 'E2' }),
    ]);
    const sel = await collectPassportGroupsByNames({ names: ['ZHANG SAN', '李四'] }, client);
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
    const sel = await collectPassportGroupsByNames({ names: ['张三', '李四', '王五'] }, client);
    expect(sel.notFoundNames).toEqual(['张三', '李四', '王五']);
  });

  it('同名同证件号跨订单命中多单：全部打包，按订单分组（证件号进文件名天然消歧）', async () => {
    const client = fakePassengerClient([
      makePassenger({ id: 'p1', orderId: 'o1', orderNumber: 'FTM2026080100001', fullName: 'ZHANG SAN', documentNumber: 'E1' }),
      makePassenger({ id: 'p2', orderId: 'o2', orderNumber: 'FTM2026080100002', fullName: 'ZHANG SAN', documentNumber: 'E1' }),
    ]);
    const sel = await collectPassportGroupsByNames({ names: ['ZHANG SAN'] }, client);
    expect(sel.notFoundNames).toEqual([]);
    expect(sel.groups).toHaveLength(2);
    expect(sel.groups.map((g) => g.orderNumber).sort()).toEqual([
      'FTM2026080100001',
      'FTM2026080100002',
    ]);
  });
});

describe('collectPassportGroupsByNames — 出发日期过滤（出发地本地日口径）', () => {
  // UTC 2026-08-01 20:00 在 Asia/Shanghai (UTC+8) 是 2026-08-02 04:00 → 出发地本地日 = 2026-08-02
  const CROSS_DAY = { time: '2026-08-01T20:00:00.000Z', tz: 'Asia/Shanghai' };

  it('departureLocalDate 按出发地时区折算（跨日班次不按 UTC 日）', async () => {
    const client = fakePassengerClient([
      makePassenger({ id: 'p1', orderId: 'o1', orderNumber: 'FTM2026080100001', fullName: 'ZHANG SAN', documentNumber: 'E1', departure: CROSS_DAY }),
    ]);
    const sel = await collectPassportGroupsByNames({ names: ['ZHANG SAN'] }, client);
    expect(sel.groups).toHaveLength(1);
    expect(sel.groups[0].departureLocalDate).toBe('2026-08-02');
  });

  it('区间命中：from/to 按本地日字符串比较（含两端）', async () => {
    const client = fakePassengerClient([
      makePassenger({ id: 'p1', orderId: 'o1', orderNumber: 'FTM2026080100001', fullName: 'ZHANG SAN', documentNumber: 'E1', departure: CROSS_DAY }),
    ]);
    const sel = await collectPassportGroupsByNames(
      { names: ['ZHANG SAN'], from: '2026-08-02', to: '2026-08-02' },
      client,
    );
    expect(sel.groups).toHaveLength(1);
    expect(sel.notFoundNames).toEqual([]);
  });

  it('区间落空：按 UTC 日会误命中的班次，本地日口径正确排除；被过滤的姓名计入未命中', async () => {
    const client = fakePassengerClient([
      makePassenger({ id: 'p1', orderId: 'o1', orderNumber: 'FTM2026080100001', fullName: 'ZHANG SAN', documentNumber: 'E1', departure: CROSS_DAY }),
    ]);
    // UTC 日是 2026-08-01，若误用 UTC 比较此处会命中
    const sel = await collectPassportGroupsByNames(
      { names: ['ZHANG SAN'], from: '2026-08-01', to: '2026-08-01' },
      client,
    );
    expect(sel.groups).toHaveLength(0);
    expect(sel.notFoundNames).toEqual(['ZHANG SAN']);
  });

  it('无航班订单：不传区间时保留（departureLocalDate 空串）；传了区间一律不命中', async () => {
    const noFlight = makePassenger({
      id: 'p1',
      orderId: 'o1',
      orderNumber: 'FTM2026080100001',
      fullName: 'ZHANG SAN',
      documentNumber: 'E1',
    });
    const client1 = fakePassengerClient([noFlight]);
    const selAll = await collectPassportGroupsByNames({ names: ['ZHANG SAN'] }, client1);
    expect(selAll.groups).toHaveLength(1);
    expect(selAll.groups[0].departureLocalDate).toBe('');

    const client2 = fakePassengerClient([noFlight]);
    const selRanged = await collectPassportGroupsByNames(
      { names: ['ZHANG SAN'], from: '2026-08-01' },
      client2,
    );
    expect(selRanged.groups).toHaveLength(0);
    expect(selRanged.notFoundNames).toEqual(['ZHANG SAN']);
  });

  it('只传单端：from 之前的排除、之后的保留', async () => {
    const client = fakePassengerClient([
      makePassenger({ id: 'p1', orderId: 'o1', orderNumber: 'FTM2026080100001', fullName: 'ZHANG SAN', documentNumber: 'E1', departure: { time: '2026-08-05T02:00:00.000Z', tz: 'Asia/Shanghai' } }),
      makePassenger({ id: 'p2', orderId: 'o2', orderNumber: 'FTM2026080100002', fullName: 'LI SI', documentNumber: 'E2', departure: { time: '2026-07-01T02:00:00.000Z', tz: 'Asia/Shanghai' } }),
    ]);
    const sel = await collectPassportGroupsByNames({ names: ['ZHANG SAN', 'LI SI'], from: '2026-08-01' }, client);
    expect(sel.groups.map((g) => g.orderNumber)).toEqual(['FTM2026080100001']);
    expect(sel.notFoundNames).toEqual(['LI SI']);
  });
});

describe('buildPassportsByNamesZip — zip 结构（按出发日期分文件夹、按姓名命名文件）', () => {
  // data:image/... 走本地解码（护照图抓取的 SSRF 防线不出网），测试无需 mock 网络
  const PHOTO = 'data:image/jpeg;base64,AQID';

  it('顶层文件夹=出发日期；文件名优先中文名；README 列文件↔订单对照 + 未命中姓名段落', async () => {
    const selection: HotelPassportsByNamesSelection = {
      groups: [
        {
          orderNumber: 'FTM2026080100001',
          departureLocalDate: '2026-08-02',
          passengers: [
            { id: 'p1', fullName: 'ZHANG SAN', lastName: 'ZHANG', firstName: 'SAN', chineseName: '张三', documentNumber: 'E1', passportPhotoUrl: PHOTO },
            // 无中文名 → LASTNAME_FIRSTNAME
            { id: 'p2', fullName: 'LI SI', lastName: 'LI', firstName: 'SI', chineseName: null, documentNumber: 'E2', passportPhotoUrl: PHOTO },
          ],
        },
      ],
      notFoundNames: ['王五'],
    };

    const { buf, photoCount } = await buildPassportsByNamesZip(selection);

    expect(photoCount).toBe(2);
    const paths = await zipPaths(buf);
    expect(paths).toContain('2026-08-02/张三_E1.jpg');
    expect(paths).toContain('2026-08-02/LI_SI_E2.jpg');
    expect(paths).toContain('README.txt');
    // 不再按订单号分文件夹
    expect(paths.some((p) => p.startsWith('FTM'))).toBe(false);

    const readme = await readText(buf, 'README.txt');
    // 文件 ↔ 订单对照（运营查单用）
    expect(readme).toContain('文件 ↔ 订单对照');
    expect(readme).toContain('2026-08-02/张三_E1.jpg  ←  订单 FTM2026080100001');
    expect(readme).toContain('2026-08-02/LI_SI_E2.jpg  ←  订单 FTM2026080100001');
    expect(readme).toContain('以下姓名未找到任何客人');
    expect(readme).toContain('王五');
  });

  it('无航班订单归「无出发日期」文件夹；缺图乘客写 README 不落文件', async () => {
    const selection: HotelPassportsByNamesSelection = {
      groups: [
        {
          orderNumber: 'FTM2026080100003',
          departureLocalDate: '',
          passengers: [
            { id: 'p1', fullName: 'WANG WU', lastName: 'WANG', firstName: 'WU', chineseName: '王五', documentNumber: 'E9', passportPhotoUrl: PHOTO },
            { id: 'p2', fullName: 'ZHAO LIU', lastName: 'ZHAO', firstName: 'LIU', chineseName: null, documentNumber: 'E8', passportPhotoUrl: null },
          ],
        },
      ],
      notFoundNames: [],
    };

    const { buf, photoCount } = await buildPassportsByNamesZip(selection);

    expect(photoCount).toBe(1);
    const paths = await zipPaths(buf);
    expect(paths).toContain('无出发日期/王五_E9.jpg');
    expect(paths.some((p) => p.includes('E8'))).toBe(false);

    const readme = await readText(buf, 'README.txt');
    expect(readme).toContain('FTM2026080100003');
    expect(readme).toContain('ZHAO_LIU_E8');
    expect(readme).toContain('没传护照照片');
  });

  it('传了出发日期区间 → README 抬头记区间；无未命中姓名时不追加该段落', async () => {
    const selection: HotelPassportsByNamesSelection = {
      groups: [],
      notFoundNames: [],
    };
    const { buf } = await buildPassportsByNamesZip(selection, { from: '2026-08-01', to: '2026-08-05' });
    const readme = await readText(buf, 'README.txt');
    expect(readme).toContain('出发日期区间：2026-08-01 ~ 2026-08-05');
    expect(readme).not.toContain('未找到任何客人');
  });

  it('不传区间 → README 无区间行', async () => {
    const selection: HotelPassportsByNamesSelection = { groups: [], notFoundNames: [] };
    const { buf } = await buildPassportsByNamesZip(selection);
    const readme = await readText(buf, 'README.txt');
    expect(readme).not.toContain('出发日期区间');
  });
});

describe('passportsByNamesZipFilename — 文件名带日期区间', () => {
  it('传了区间 → 插入 出发{from}至{to}；单端缺省记「不限」；不传不插', () => {
    expect(passportsByNamesZipFilename(['a', 'b'], { from: '2026-08-01', to: '2026-08-05' })).toContain(
      '2人_出发2026-08-01至2026-08-05',
    );
    expect(passportsByNamesZipFilename(['a'], { from: '2026-08-01' })).toContain('出发2026-08-01至不限');
    expect(passportsByNamesZipFilename(['a'])).not.toContain('出发');
  });
});
