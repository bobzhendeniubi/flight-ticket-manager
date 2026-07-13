/**
 * 护照图片批量打包 zip — 房控岗 / 操作部用
 *
 * 两种取数入口：
 *   1. 按酒店一键导出（collectHotelPassportGroups）：酒店 + 入住日期区间 [from, to]（含两端）。
 *      入住该酒店、hotelCheckIn 落在区间内的占房订单行（HOTEL 行 + 套餐盖章 hotelRoomTypeId 的
 *      BUNDLE 行都命中），排除已取消/软删订单（与销控板/分房表同口径 COUNTED_STATUSES）。
 *      同一订单区间内多晚/多行只归并一次；同一乘客不重复打包。
 *   2. 按姓名批量导出（collectPassportGroupsByNames）：不限酒店/日期，直接按姓名列表命中乘客
 *      （fullName 大小写不敏感 或 chineseName 精确 trim 匹配，命中任一即可），排除已取消/软删订单
 *      （同 COUNTED_STATUSES）。同名同证件号跨订单命中多单时全部打包（按订单分文件夹天然消歧）；
 *      未命中的姓名单独返回，供路由/前端提示。
 *
 * 输出：zip Buffer，结构：
 *   {orderNumber}/{LASTNAME}_{护照号}.{ext}   （仅有图乘客）
 *   README.txt                                （zip 根部；列出哪单哪人缺护照图，按姓名导出时
 *                                                额外列出未命中的姓名）
 *
 * 缺照片不报错 —— 写进根部 README.txt。无命中订单、或全员都没上传护照图，由路由层返回 400。
 */
import JSZip from 'jszip';
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { sanitize, extFromUrl, fetchPhoto } from '../orders/passport-zip.js';
import { COUNTED_STATUSES } from './hotel-control.service.js';

/** 打包用的最小乘客形态（只取护照打包/命名所需字段）。*/
export interface PassportPassenger {
  id: string;
  fullName: string;
  lastName: string | null;
  firstName: string | null;
  documentNumber: string;
  passportPhotoUrl: string | null;
}

/** 一张订单的待打包乘客集合（区间内多晚/多行已归并为一份）。*/
export interface HotelPassportGroup {
  orderNumber: string;
  passengers: PassportPassenger[];
}

export interface HotelPassportSelection {
  hotelName: string | null;
  groups: HotelPassportGroup[];
}

/** 按姓名批量导出的取数结果：命中的乘客（按订单分组）+ 未命中的姓名列表。*/
export interface HotelPassportsByNamesSelection {
  groups: HotelPassportGroup[];
  notFoundNames: string[];
}

function toDateOnly(s: string): Date {
  // 'YYYY-MM-DD' → UTC midnight，与 Prisma @db.Date 存取口径一致
  return new Date(`${s}T00:00:00.000Z`);
}

/**
 * 护照文件名用的「姓」：优先已拆分 lastName；手工录入未拆分时从 fullName 尽力取首段
 * （斜线 LAST/FIRST 或空格分隔），不编造，取不到留空。
 */
function lastNameOf(p: PassportPassenger): string {
  const last = (p.lastName ?? '').trim();
  if (last) return last.toUpperCase();
  const full = (p.fullName ?? '').trim();
  if (!full) return '';
  if (full.includes('/')) return full.split('/')[0].toUpperCase();
  return full.split(/\s+/u)[0].toUpperCase();
}

/**
 * 选出该酒店该入住区间内的占房订单，按订单归并出待打包乘客（去重）。
 * @param client 可注入用于测试；缺省取默认 prisma。
 */
export async function collectHotelPassportGroups(
  args: { hotelId: string; from: string; to: string },
  client: PrismaClient = defaultPrisma,
): Promise<HotelPassportSelection> {
  const fromD = toDateOnly(args.from);
  const toD = toDateOnly(args.to);

  const items = await client.orderItem.findMany({
    where: {
      hotelRoomTypeId: { not: null },
      hotelRoomType: { hotelId: args.hotelId },
      hotelCheckIn: { gte: fromD, lte: toD },
      order: { deletedAt: null, status: { in: COUNTED_STATUSES } },
    },
    orderBy: { createdAt: 'asc' },
    include: {
      hotelRoomType: { select: { hotel: { select: { name: true } } } },
      order: {
        select: {
          id: true,
          orderNumber: true,
          passengers: {
            select: {
              id: true,
              fullName: true,
              lastName: true,
              firstName: true,
              documentNumber: true,
              passportPhotoUrl: true,
            },
          },
        },
      },
    },
  });

  // 同订单多晚/多行只归并一次；乘客随订单一并去重（按 orderId 唯一）
  const byOrder = new Map<string, HotelPassportGroup>();
  let hotelName: string | null = null;
  for (const it of items) {
    if (!hotelName) hotelName = it.hotelRoomType?.hotel?.name ?? null;
    if (byOrder.has(it.order.id)) continue;
    byOrder.set(it.order.id, {
      orderNumber: it.order.orderNumber,
      passengers: it.order.passengers,
    });
  }

  return { hotelName, groups: Array.from(byOrder.values()) };
}

/** 选中乘客里是否至少有一人上传了护照图（决定是否值得打包；无 → 路由 400）。*/
export function hasAnyPassportPhoto(groups: HotelPassportGroup[]): boolean {
  return groups.some((g) => g.passengers.some((p) => p.passportPhotoUrl));
}

/**
 * 按姓名列表查乘客（不限酒店/日期）：fullName 大小写不敏感 或 chineseName 精确 trim 匹配，
 * 命中任一即算命中。仅关联订单未软删且状态在 COUNTED_STATUSES（同销控板/分房表口径）。
 * 同名同证件号跨订单命中多单时全部打包，按订单分文件夹天然消歧。
 * @param names 姓名列表（允许含前后空白，函数内部会 trim + 去重后再查）。
 * @param client 可注入用于测试；缺省取默认 prisma。
 */
export async function collectPassportGroupsByNames(
  names: string[],
  client: PrismaClient = defaultPrisma,
): Promise<HotelPassportsByNamesSelection> {
  const uniqueNames = Array.from(new Set(names.map((n) => n.trim()).filter(Boolean)));

  if (uniqueNames.length === 0) {
    return { groups: [], notFoundNames: [] };
  }

  const passengers = await client.passenger.findMany({
    where: {
      order: { deletedAt: null, status: { in: COUNTED_STATUSES } },
      OR: uniqueNames.map((name) => ({
        OR: [{ fullName: { equals: name, mode: 'insensitive' } }, { chineseName: name }],
      })),
    },
    orderBy: { order: { createdAt: 'asc' } },
    select: {
      id: true,
      fullName: true,
      lastName: true,
      firstName: true,
      chineseName: true,
      documentNumber: true,
      passportPhotoUrl: true,
      order: { select: { id: true, orderNumber: true } },
    },
  });

  const byOrder = new Map<string, HotelPassportGroup>();
  const matchedNames = new Set<string>();
  for (const p of passengers) {
    const fullNameLower = (p.fullName ?? '').trim().toLowerCase();
    const chineseName = (p.chineseName ?? '').trim();
    for (const name of uniqueNames) {
      if (fullNameLower === name.toLowerCase() || (chineseName && chineseName === name)) {
        matchedNames.add(name);
      }
    }

    const key = p.order.id;
    const group = byOrder.get(key) ?? { orderNumber: p.order.orderNumber, passengers: [] };
    group.passengers.push({
      id: p.id,
      fullName: p.fullName,
      lastName: p.lastName,
      firstName: p.firstName,
      documentNumber: p.documentNumber,
      passportPhotoUrl: p.passportPhotoUrl,
    });
    byOrder.set(key, group);
  }

  const notFoundNames = uniqueNames.filter((n) => !matchedNames.has(n));

  return { groups: Array.from(byOrder.values()), notFoundNames };
}

/**
 * 把按订单归并的乘客写入 zip：每订单一个文件夹放护照图，缺图/下载失败记入 missing 列表
 * （由调用方拼进 README.txt，两个打包入口的 README 抬头不同，故不在此处生成）。
 */
async function packGroupsIntoZip(
  zip: JSZip,
  groups: HotelPassportGroup[],
): Promise<{ missing: string[]; photoCount: number; passengerCount: number }> {
  const missing: string[] = [];
  let photoCount = 0;
  let passengerCount = 0;

  for (const group of groups) {
    const folder = zip.folder(group.orderNumber) ?? zip;
    for (const p of group.passengers) {
      passengerCount += 1;
      const slug = sanitize(`${lastNameOf(p)}_${p.documentNumber}`);
      if (!p.passportPhotoUrl) {
        missing.push(`${group.orderNumber}  ·  ${slug}  — 该乘客没传护照照片`);
        continue;
      }
      const buf = await fetchPhoto(p.passportPhotoUrl);
      if (!buf) {
        missing.push(`${group.orderNumber}  ·  ${slug}  — 护照图下载失败 (${p.passportPhotoUrl})`);
        continue;
      }
      folder.file(`${slug}.${extFromUrl(p.passportPhotoUrl)}`, buf);
      photoCount += 1;
    }
  }

  return { missing, photoCount, passengerCount };
}

/**
 * 把按订单归并的乘客打成 zip：每订单一个文件夹放护照图，缺图/下载失败写进根部 README.txt。
 * @returns zip Buffer + 实际成功打入的照片数（photoCount）。
 */
export async function buildHotelPassportsZip(
  selection: HotelPassportSelection,
  meta: { hotelId: string; from: string; to: string },
): Promise<{ buf: Buffer; photoCount: number }> {
  const zip = new JSZip();
  const { missing, photoCount, passengerCount } = await packGroupsIntoZip(zip, selection.groups);

  const readme = [
    `酒店：${selection.hotelName ?? meta.hotelId}`,
    `入住区间：${meta.from} ~ ${meta.to}`,
    `打包时间：${new Date().toISOString()}`,
    `订单数：${selection.groups.length}`,
    `乘客总数：${passengerCount}`,
    `成功打包护照图：${photoCount}`,
    `缺失/失败：${missing.length}`,
    '',
    ...(missing.length
      ? ['⚠ 缺护照图（订单 · 乘客）：', ...missing.map((s) => `  · ${s}`)]
      : ['✓ 所有乘客护照图均已打包']),
  ].join('\n');
  zip.file('README.txt', readme);

  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buf: out, photoCount };
}

/**
 * 把按姓名命中的乘客打成 zip：结构与 buildHotelPassportsZip 一致（按订单分文件夹），
 * README.txt 里除缺图客人外，未命中的姓名单独列一段。
 * @returns zip Buffer + 实际成功打入的照片数（photoCount）。
 */
export async function buildPassportsByNamesZip(
  selection: HotelPassportsByNamesSelection,
): Promise<{ buf: Buffer; photoCount: number }> {
  const zip = new JSZip();
  const { missing, photoCount, passengerCount } = await packGroupsIntoZip(zip, selection.groups);

  const readme = [
    '按姓名批量导出护照',
    `打包时间：${new Date().toISOString()}`,
    `订单数：${selection.groups.length}`,
    `乘客总数：${passengerCount}`,
    `成功打包护照图：${photoCount}`,
    `缺失/失败：${missing.length}`,
    '',
    ...(missing.length
      ? ['⚠ 缺护照图（订单 · 乘客）：', ...missing.map((s) => `  · ${s}`)]
      : ['✓ 所有乘客护照图均已打包']),
    ...(selection.notFoundNames.length
      ? ['', '⚠ 以下姓名未找到任何客人：', ...selection.notFoundNames.map((n) => `  · ${n}`)]
      : []),
  ].join('\n');
  zip.file('README.txt', readme);

  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buf: out, photoCount };
}

/** 文件名：`护照_{hotelName}_{from}_{to}.zip`（无酒店名时用 hotelId）。*/
export function hotelPassportsZipFilename(
  hotelName: string | null,
  hotelId: string,
  from: string,
  to: string,
): string {
  return `护照_${sanitize(hotelName ?? hotelId)}_${from}_${to}.zip`;
}

/** 文件名：`护照_按姓名_{n}人_{YYYY-MM-DD}.zip`。*/
export function passportsByNamesZipFilename(names: string[]): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `护照_按姓名_${names.length}人_${stamp}.zip`;
}
