/**
 * 护照图片批量打包 zip — 房控岗 / 操作部用
 *
 * 两种取数入口：
 *   1. 按酒店一键导出（collectHotelPassportGroups）：酒店 + 入住日期区间 [from, to]（含两端）。
 *      入住该酒店、hotelCheckIn 落在区间内的占房订单行（HOTEL 行 + 套餐盖章 hotelRoomTypeId 的
 *      BUNDLE 行都命中），排除已取消/软删订单（与销控板/分房表同口径 COUNTED_STATUSES）。
 *      同一订单区间内多晚/多行只归并一次；同一乘客不重复打包。
 *   2. 按姓名批量导出（collectPassportGroupsByNames）：不限酒店，直接按姓名列表命中乘客
 *      （fullName 大小写不敏感 或 chineseName 精确 trim 匹配，命中任一即可），排除已取消/软删订单
 *      （同 COUNTED_STATUSES）。可选按出发日期区间 [from, to]（含两端）过滤：口径 = 订单最早一段
 *      FLIGHT 的 departureTime 按 departureTz 折算的「出发地本地日」（复用 fmtDepartureLocalDate，
 *      不做 UTC 比较，避免跨时区错日）；无航班的订单（纯签证单/纯酒店单）没有出发日 → 不被区间筛掉，
 *      归入「无出发日期」文件夹（与签证台出发日过滤同口径）。
 *      同名跨订单命中多单时全部打包（证件号进文件名天然消歧）。
 *      两类「没导出来」的姓名分开返回，避免错误归因：
 *        · notFoundNames        —— 库里压根没这个人（姓名写错/没录单）→ 改姓名重试才有用
 *        · excludedByDateNames  —— 人找到了，但出发日不在所选区间 → 该改的是日期区间
 *      早先版本把后者混进 notFoundNames，看到的是「查无此人」，会去改名字，永远查不到真因。
 *
 * 输出：zip Buffer，结构（两个入口不同——按酒店给房控对订单，按姓名给运营按出发日找人）：
 *   按酒店：{orderNumber}/{LASTNAME}_{护照号}.{ext}
 *   按姓名：{出发日期 YYYY-MM-DD 或 无出发日期}/{中文名或LASTNAME_FIRSTNAME}_{护照号}.{ext}
 *   README.txt   （zip 根部；列出哪单哪人缺护照图；按姓名导出时额外列出
 *                   每个文件对应的订单号（查单用）+ 未命中的姓名）
 *
 * 缺照片不报错 —— 写进根部 README.txt。无命中订单、或全员都没上传护照图，由路由层返回 400。
 */
import JSZip from 'jszip';
import { OrderItemKind, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { sanitize, extFromUrl, fetchPhoto, fmtDepartureLocalDate } from '../orders/passport-zip.js';
import { COUNTED_STATUSES } from './hotel-control.service.js';

/** 打包用的最小乘客形态（只取护照打包/命名所需字段）。*/
export interface PassportPassenger {
  id: string;
  fullName: string;
  lastName: string | null;
  firstName: string | null;
  /** 中文姓名 —— 按姓名导出的文件命名优先用它；按酒店导出不取（可缺省）。*/
  chineseName?: string | null;
  documentNumber: string;
  passportPhotoUrl: string | null;
}

/** 一张订单的待打包乘客集合（区间内多晚/多行已归并为一份）。*/
export interface HotelPassportGroup {
  orderNumber: string;
  /**
   * 订单最早一段 FLIGHT 的出发地本地日（YYYY-MM-DD；无航班 ''）。
   * 仅按姓名导出取数时填（zip 按它分文件夹）；按酒店导出不取（可缺省）。
   */
  departureLocalDate?: string;
  passengers: PassportPassenger[];
}

export interface HotelPassportSelection {
  hotelName: string | null;
  groups: HotelPassportGroup[];
}

/**
 * 按姓名批量导出的取数结果：命中的乘客（按订单分组）+ 两类没导出来的姓名（互斥，别混）。
 */
export interface HotelPassportsByNamesSelection {
  groups: HotelPassportGroup[];
  /** 库里查无此人（姓名写错 / 还没录单）。改姓名重试才有用。*/
  notFoundNames: string[];
  /**
   * 人找到了，但订单出发日不在所选区间 → 未导出。该改的是日期区间，不是姓名。
   * 只包含「所有命中单都被区间排除」的姓名；同名跨订单只要有一单落在区间内就不算。
   * 无出发日的订单（纯签证单/纯酒店单）不算被日期排除 —— 它们归「无出发日期」文件夹照常导出。
   */
  excludedByDateNames: string[];
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
 * 按姓名导出的文件名用「姓名」：优先中文姓名；无中文名用 LASTNAME_FIRSTNAME
 * （未拆分时回退 fullName 尽力拆，斜线 LAST/FIRST 或空格分隔），不编造，取不到留空
 * （文件名还有证件号兜底消歧）。
 */
function displayNameOf(p: PassportPassenger): string {
  const cn = (p.chineseName ?? '').trim();
  if (cn) return cn;
  const last = (p.lastName ?? '').trim().toUpperCase();
  const first = (p.firstName ?? '').trim().toUpperCase();
  if (last || first) return [last, first].filter(Boolean).join('_');
  const full = (p.fullName ?? '').trim().toUpperCase();
  if (!full) return '';
  if (full.includes('/')) {
    return full
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
      .join('_');
  }
  return full.split(/\s+/u).join('_');
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
 * 按姓名列表查乘客（不限酒店）：fullName 大小写不敏感 或 chineseName 精确 trim 匹配，
 * 命中任一即算命中。仅关联订单未软删且状态在 COUNTED_STATUSES（同销控板/分房表口径）。
 * 可选按出发日期过滤：每订单取最早一段 FLIGHT 的 departureTime，按 departureTz 折算成
 * 「出发地本地日」YYYY-MM-DD 字符串后与 from/to 比较（不做 UTC gte/lte，避免跨时区错日）；
 * 无航班订单出发日为 ''，不被区间筛掉（归「无出发日期」文件夹）。
 * 同名跨订单命中多单时全部打包（证件号进文件名天然消歧）。
 *
 * 姓名匹配先于日期过滤 —— 被日期排除的人已经算「找到了」，只会进 excludedByDateNames，
 * 绝不会假冒 notFoundNames 的「查无此人」（否则会被误导去改姓名，而真因是日期区间）。
 *
 * @param args.names 姓名列表（允许含前后空白，函数内部会 trim + 去重后再查）。
 * @param args.from / args.to 可选出发日期区间（YYYY-MM-DD，含两端；可只传一端）。
 * @param client 可注入用于测试；缺省取默认 prisma。
 */
export async function collectPassportGroupsByNames(
  args: { names: string[]; from?: string; to?: string },
  client: PrismaClient = defaultPrisma,
): Promise<HotelPassportsByNamesSelection> {
  const uniqueNames = Array.from(new Set(args.names.map((n) => n.trim()).filter(Boolean)));

  if (uniqueNames.length === 0) {
    return { groups: [], notFoundNames: [], excludedByDateNames: [] };
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
      order: {
        select: {
          id: true,
          orderNumber: true,
          // 最早一段机票 → 出发日（与送签表 departureLocalDate 同口径）
          items: {
            where: { kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
            orderBy: { flightSchedule: { departureTime: 'asc' } },
            take: 1,
            select: { flightSchedule: { select: { departureTime: true, departureTz: true } } },
          },
        },
      },
    },
  });

  const byOrder = new Map<string, HotelPassportGroup>();
  /** 库里查到了这个人（不论出发日是否落在区间内）—— 定 notFoundNames 用。*/
  const matchedNames = new Set<string>();
  /** 这个人真的被打进了 zip —— 定 excludedByDateNames 用。*/
  const includedNames = new Set<string>();
  for (const p of passengers) {
    const fs = p.order.items[0]?.flightSchedule ?? null;
    const departureLocalDate = fmtDepartureLocalDate(
      fs?.departureTime ?? null,
      fs?.departureTz ?? null,
    );

    // 姓名匹配必须先于日期过滤：被日期排除的人也算「找到了」，否则会假冒「查无此人」
    const fullNameLower = (p.fullName ?? '').trim().toLowerCase();
    const chineseName = (p.chineseName ?? '').trim();
    const hitNames = uniqueNames.filter(
      (name) => fullNameLower === name.toLowerCase() || (chineseName && chineseName === name),
    );
    for (const name of hitNames) matchedNames.add(name);

    // 出发地本地日字符串比较（YYYY-MM-DD 字典序 = 日期序）。
    // 无出发日（纯签证单/纯酒店单）→ 不被日期区间筛掉，归入「无出发日期」文件夹。
    // 与签证台 departureDate 过滤同口径（纯签证单无航班 → 保留可见）。
    if (departureLocalDate) {
      if (args.from && departureLocalDate < args.from) continue;
      if (args.to && departureLocalDate > args.to) continue;
    }

    for (const name of hitNames) includedNames.add(name);

    const key = p.order.id;
    const group =
      byOrder.get(key) ??
      { orderNumber: p.order.orderNumber, departureLocalDate, passengers: [] };
    group.passengers.push({
      id: p.id,
      fullName: p.fullName,
      lastName: p.lastName,
      firstName: p.firstName,
      chineseName: p.chineseName,
      documentNumber: p.documentNumber,
      passportPhotoUrl: p.passportPhotoUrl,
    });
    byOrder.set(key, group);
  }

  // 两类分开（互斥）：查无此人 vs 找到了但出发日不在区间。混在一起就是错误归因。
  const notFoundNames = uniqueNames.filter((n) => !matchedNames.has(n));
  const excludedByDateNames = uniqueNames.filter((n) => matchedNames.has(n) && !includedNames.has(n));

  return { groups: Array.from(byOrder.values()), notFoundNames, excludedByDateNames };
}

/** 按姓名导出 zip 里无航班订单（纯签证单/纯酒店单）的文件夹名。*/
const NO_DEPARTURE_FOLDER = '无出发日期';

/**
 * 按姓名导出专用打包：顶层文件夹 = 出发日期（YYYY-MM-DD；无航班订单归「无出发日期」），
 * 文件名 = {姓名}_{证件号}.{ext}（姓名优先中文名）。缺图/下载失败记入 missing；
 * 成功打入的文件逐个记入 manifest（文件 ← 订单号，供查单）。
 * noDepartureCount = 归进「无出发日期」文件夹的乘客数，供 README 明写（不能静默）。
 * 「按酒店」导出仍走 packGroupsIntoZip（按订单号分文件夹），两者结构互不影响。
 */
async function packGroupsByDepartureDateIntoZip(
  zip: JSZip,
  groups: HotelPassportGroup[],
): Promise<{
  missing: string[];
  manifest: string[];
  photoCount: number;
  passengerCount: number;
  noDepartureCount: number;
}> {
  const missing: string[] = [];
  const manifest: string[] = [];
  let photoCount = 0;
  let passengerCount = 0;
  let noDepartureCount = 0;

  for (const group of groups) {
    const folderName = (group.departureLocalDate ?? '').trim() || NO_DEPARTURE_FOLDER;
    const folder = zip.folder(folderName) ?? zip;
    for (const p of group.passengers) {
      passengerCount += 1;
      if (folderName === NO_DEPARTURE_FOLDER) noDepartureCount += 1;
      const slug = sanitize(`${displayNameOf(p)}_${p.documentNumber}`);
      if (!p.passportPhotoUrl) {
        missing.push(`${group.orderNumber}  ·  ${slug}  — 该乘客没传护照照片`);
        continue;
      }
      const buf = await fetchPhoto(p.passportPhotoUrl);
      if (!buf) {
        missing.push(`${group.orderNumber}  ·  ${slug}  — 护照图下载失败 (${p.passportPhotoUrl})`);
        continue;
      }
      const fileName = `${slug}.${extFromUrl(p.passportPhotoUrl)}`;
      folder.file(fileName, buf);
      manifest.push(`${folderName}/${fileName}  ←  订单 ${group.orderNumber}`);
      photoCount += 1;
    }
  }

  return { missing, manifest, photoCount, passengerCount, noDepartureCount };
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
 * 把按姓名命中的乘客打成 zip：顶层文件夹 = 出发日期（无航班订单归「无出发日期」），
 * 文件名 = {姓名}_{证件号}.{ext}（姓名优先中文名）。README.txt 里列出每个文件对应的
 * 订单号（查单用）、缺图客人、以及两类没导出来的姓名（查无此人 / 出发日不在区间）——
 * 两类分开写，别让「日期没对上」看着像「人不存在」。传了出发日期区间时一并记入抬头。
 * @returns zip Buffer + 实际成功打入的照片数（photoCount）。
 */
export async function buildPassportsByNamesZip(
  selection: HotelPassportsByNamesSelection,
  meta?: { from?: string; to?: string },
): Promise<{ buf: Buffer; photoCount: number }> {
  const zip = new JSZip();
  const { missing, manifest, photoCount, passengerCount, noDepartureCount } =
    await packGroupsByDepartureDateIntoZip(zip, selection.groups);

  const hasRange = Boolean(meta?.from || meta?.to);
  const readme = [
    '按姓名批量导出护照（按出发日期分文件夹）',
    ...(hasRange ? [`出发日期区间：${meta?.from ?? '不限'} ~ ${meta?.to ?? '不限'}（出发地本地日）`] : []),
    `打包时间：${new Date().toISOString()}`,
    `订单数：${selection.groups.length}`,
    `乘客总数：${passengerCount}`,
    `成功打包护照图：${photoCount}`,
    `缺失/失败：${missing.length}`,
    '',
    ...(manifest.length
      ? ['文件 ↔ 订单对照（查单用）：', ...manifest.map((s) => `  · ${s}`), '']
      : []),
    ...(missing.length
      ? ['⚠ 缺护照图（订单 · 乘客）：', ...missing.map((s) => `  · ${s}`)]
      : ['✓ 所有乘客护照图均已打包']),
    // 无出发日的单（纯签证单/纯酒店单）照常导出，但要明说，别让人以为漏了
    ...(noDepartureCount
      ? [
          '',
          `ℹ ${noDepartureCount} 位客人所在订单没有机票（纯签证单/纯酒店单），无出发日期，`,
          `  已归入「${NO_DEPARTURE_FOLDER}」文件夹${hasRange ? '（不受出发日期区间过滤）' : ''}。`,
        ]
      : []),
    // 找到了人、但出发日不在区间 → 该改的是日期区间，不是姓名
    ...(selection.excludedByDateNames.length
      ? [
          '',
          '⚠ 以下姓名找到了客人，但订单出发日期不在所选区间，未导出（要导出请改日期区间）：',
          ...selection.excludedByDateNames.map((n) => `  · ${n}`),
        ]
      : []),
    // 真·查无此人 → 该改的是姓名
    ...(selection.notFoundNames.length
      ? ['', '⚠ 以下姓名未找到任何客人（姓名可能写错，或该客人还没录单）：', ...selection.notFoundNames.map((n) => `  · ${n}`)]
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

/**
 * 文件名：`护照_按姓名_{n}人_{YYYY-MM-DD}.zip`；
 * 传了出发日期区间时插入 `_出发{from}至{to}`（单端缺省记「不限」）。
 */
export function passportsByNamesZipFilename(
  names: string[],
  range?: { from?: string; to?: string },
): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const rangePart =
    range?.from || range?.to ? `_出发${range?.from ?? '不限'}至${range?.to ?? '不限'}` : '';
  return `护照_按姓名_${names.length}人${rangePart}_${stamp}.zip`;
}
