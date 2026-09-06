/**
 * 公开航线 / 机场 / 酒店城市聚合 —— 供前台（sales-web）与小程序动态拉取，
 * 不再由前端写死「只有 MFM⇌DAD 一条线」。
 *
 * 公司马上开第二条直飞航线（目的地未定），前台要能同时卖两条线：这三个端点让
 * 前端从"数据库里实际在卖什么"派生展示内容，而不是编译时写死。
 *
 *   listPublicRoutes      —— 活跃航班（Flight.isActive=true）按 (起降机场) 去重聚合，
 *                             每条附两端机场展示信息（含 IANA 时区）。
 *   listPublicAirports    —— 出现在活跃航班里的机场清单（起飞/降落两端去重）。
 *   listPublicHotelCities —— 在架酒店（Hotel.isActive=true）的 distinct 城市码 + 中文名。
 *
 * 三者都只读聚合，不暴露任何库存/价格数字，权限与 GET /public/payment-channels 同级
 * （公开只读，无需登录）。
 */
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { cityName, resolveAirport, type AirportInfo } from '../../lib/airports.js';

export interface PublicRoute {
  originCode: string;
  destinationCode: string;
  origin: AirportInfo;
  destination: AirportInfo;
}

export interface PublicHotelCity {
  code: string;
  name: string;
}

/** 按 (originCode, destinationCode) 排序，保证响应顺序稳定（前端第一条即默认航线）。 */
function sortByRoute<T extends { originCode: string; destinationCode: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) => a.originCode.localeCompare(b.originCode) || a.destinationCode.localeCompare(b.destinationCode),
  );
}

/** 活跃航班的 distinct 航线（起降机场对），附两端机场展示信息。 */
export async function listPublicRoutes(client: PrismaClient = defaultPrisma): Promise<PublicRoute[]> {
  const rows = await client.flight.findMany({
    where: { isActive: true },
    select: { originCode: true, destinationCode: true },
    distinct: ['originCode', 'destinationCode'],
  });
  return sortByRoute(rows).map((r) => ({
    originCode: r.originCode,
    destinationCode: r.destinationCode,
    origin: resolveAirport(r.originCode),
    destination: resolveAirport(r.destinationCode),
  }));
}

/** 出现在活跃航班里的机场（起飞 + 降落两端去重），按代码排序。 */
export async function listPublicAirports(client: PrismaClient = defaultPrisma): Promise<AirportInfo[]> {
  const rows = await client.flight.findMany({
    where: { isActive: true },
    select: { originCode: true, destinationCode: true },
  });
  const codes = new Set<string>();
  for (const r of rows) {
    codes.add(r.originCode);
    codes.add(r.destinationCode);
  }
  return Array.from(codes)
    .sort()
    .map((code) => resolveAirport(code));
}

/** 在架酒店的 distinct 城市码 + 中文名（含非机场码，如会安 HOA，见 lib/airports.ts）。 */
export async function listPublicHotelCities(
  client: PrismaClient = defaultPrisma,
): Promise<PublicHotelCity[]> {
  const rows = await client.hotel.findMany({
    where: { isActive: true },
    select: { cityCode: true },
    distinct: ['cityCode'],
  });
  return rows
    .map((r) => r.cityCode)
    .sort()
    .map((code) => ({ code, name: cityName(code) }));
}
