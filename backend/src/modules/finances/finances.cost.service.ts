/**
 * 财务成本编辑 service
 *
 * 给 admin-web「成本维护」tab 和产品管理页提供各产品成本字段的 patch。
 * 成本统一人民币（CNY）——已移除汇率 / 多币种。
 * 所有写操作由 routes 层负责 ADMIN 鉴权 + 审计日志。
 */
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';

// ── 产品成本 patch（统一 CNY）─────────────────────────────────────────────────

export async function patchFlightScheduleCost(
  id: string,
  data: {
    charterCostCny?: number | null;
    airportTaxDepCny?: number | null;
    airportTaxArrCny?: number | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string }> {
  await client.flightSchedule.update({ where: { id }, data });
  return { id };
}

export async function patchHotelRoomTypeCost(
  id: string,
  data: { costPriceCny?: number | null },
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string }> {
  await client.hotelRoomType.update({ where: { id }, data });
  return { id };
}

export async function patchVisaCost(
  id: string,
  data: { costPriceCny?: number | null },
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string }> {
  await client.visa.update({ where: { id }, data });
  return { id };
}

export async function patchTransferCost(
  id: string,
  data: { costPriceCny?: number | null },
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string }> {
  await client.transfer.update({ where: { id }, data });
  return { id };
}
