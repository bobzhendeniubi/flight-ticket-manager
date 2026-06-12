/**
 * OrderCostItem 服务 — 订单杂项成本明细的 CRUD
 *
 * 跟 OrderItem 区分：
 *   - OrderItem：面向客户的商品行（航班/酒店/签证/...）
 *   - OrderCostItem：后台财务录入的订单级成本明细
 *     按贺帅细分维度：导游服务费 / 赠送费用 / 手续费（收款/汇款结算）/ 操作费（每单固定）/ 其他
 *
 * 一张订单可有 N 条（一类可多条）。
 * Decimal ↔ number 在 service 层完成；日期出 ISO 字符串。
 * 鉴权 + 审计由 routes 层负责。
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';

export type OrderCostCategoryDto =
  | 'GUIDE_SERVICE'
  | 'COMP_GIFT'
  | 'HANDLING_FEE'
  | 'OPERATION_FEE'
  | 'OTHER';

export const OPERATION_FEE_CNY_PER_ORDER = 20; // 财务定：每单固定操作费（人员服务费）

export interface OrderCostItemDto {
  id: string;
  orderId: string;
  category: OrderCostCategoryDto;
  amountCny: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrderCostItemInput {
  category: OrderCostCategoryDto;
  amountCny: number;
  note?: string | null;
}

export interface UpdateOrderCostItemInput {
  category?: OrderCostCategoryDto;
  amountCny?: number;
  note?: string | null;
}

type DbOrderCostItem = {
  id: string;
  orderId: string;
  category: OrderCostCategoryDto;
  amountCny: Prisma.Decimal;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function decToNumber(v: Prisma.Decimal): number {
  return Number(v.toString());
}

function toDto(row: DbOrderCostItem): OrderCostItemDto {
  return {
    id: row.id,
    orderId: row.orderId,
    category: row.category,
    amountCny: decToNumber(row.amountCny),
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 列出某订单的全部成本明细，按 createdAt 升序 */
export async function listByOrder(
  orderId: string,
  client: PrismaClient = defaultPrisma,
): Promise<OrderCostItemDto[]> {
  const rows = await client.orderCostItem.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toDto);
}

/** 新增一条成本明细 */
export async function create(
  orderId: string,
  input: CreateOrderCostItemInput,
  client: PrismaClient = defaultPrisma,
): Promise<OrderCostItemDto> {
  const row = await client.orderCostItem.create({
    data: {
      orderId,
      category: input.category,
      amountCny: new Prisma.Decimal(input.amountCny),
      note: input.note ?? null,
    },
  });
  return toDto(row);
}

/** 更新一条成本明细（部分字段） */
export async function update(
  id: string,
  input: UpdateOrderCostItemInput,
  client: PrismaClient = defaultPrisma,
): Promise<OrderCostItemDto> {
  const data: Prisma.OrderCostItemUpdateInput = {};
  if (input.category !== undefined) data.category = input.category;
  if (input.amountCny !== undefined) data.amountCny = new Prisma.Decimal(input.amountCny);
  if (input.note !== undefined) data.note = input.note;
  const row = await client.orderCostItem.update({
    where: { id },
    data,
  });
  return toDto(row);
}

/** 删除一条成本明细 */
export async function remove(
  id: string,
  client: PrismaClient = defaultPrisma,
): Promise<{ id: string }> {
  await client.orderCostItem.delete({ where: { id } });
  return { id };
}
