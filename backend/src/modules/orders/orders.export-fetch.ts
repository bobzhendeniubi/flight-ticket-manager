/**
 * 导出取数：分批拉订单（所有 xlsx/zip 导出共用）。
 *
 * 为什么要分批 ——
 * 导出用的 include 是七层嵌套（乘客/收款/退款/行项/班次/航班/酒店房型/签证/履约任务…），
 * 一张单展开后的 JSON 很大。Prisma 的查询引擎跑在 Rust 侧，会把**整份结果**序列化成
 * 一个 JSON 字符串、再经 napi 交回 Node；这个单字符串有长度上限，一裸查整月就会炸成
 *   `Failed to convert rust \`String\` into napi \`string\``
 * （表现为按筛选导出整月 500）。和宿主内存无关 —— 加内存救不了，只能把单次结果切小。
 *
 * 做法：先只取 id（一行一个短字符串，序列化压力可忽略）拿到**完整且保序**的集合，
 * 再按 id 切片把带 include 的实体分几次取回，最后按第一步的 id 顺序重排拼接。
 * 对调用方而言语义与一次裸查完全一致：同样的 where / orderBy / include，同样的顺序。
 *
 * 两步都带同一份 where（第二步 = `where AND id in (...)`），不是冗余：where 里装着
 * 代理可见集合（agentScope）、软删闸、状态闸这些**权限与口径条件**，而取回后的内存精筛
 * （filterExportOrders）只管日期与单程/往返，不复核归属。第二步若只按 id 取，两步之间
 * 被改归别家代理 / 被取消 / 被软删的单就会照样取回来导出去。
 */
import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * 单批订单条数。
 *
 * 取 150 的理由：napi 的单字符串上限是「整份结果的字节数」，不是条数 —— 实测九月单量下
 * 9 天（约 200 单）还能过、10 天就炸，说明临界点在两三百单量级。150 留了一倍余量，
 * 同时把往返查询次数控制在个位数（整月几百单 = 2~5 批），不会把一次导出拖成 N+1。
 * 真要再调，宁可调小：多几次往返只慢几十毫秒，超限就是直接 500。
 */
export const ORDER_EXPORT_CHUNK_SIZE = 150;

/** 与一次裸 findMany 同形的取数参数（调用方原样传入，口径不做任何改写）。*/
export interface OrderExportFetchArgs {
  where: Prisma.OrderWhereInput;
  orderBy?: Prisma.OrderOrderByWithRelationInput | Prisma.OrderOrderByWithRelationInput[];
  include: Prisma.OrderInclude;
}

/**
 * 分批取回导出所需订单，结果顺序 = 按 orderBy 排好的顺序（与一次裸查一致）。
 *
 * @param client    Prisma client（测试可注入假 client）
 * @param args      where / orderBy / include —— 与原裸查一字不差地透传
 * @param chunkSize 单批条数，缺省 ORDER_EXPORT_CHUNK_SIZE
 *
 * 注：两步之间若有订单被改动到**不再命中 where**（被软删、被取消、被改归别家代理…），
 * 第二步就取不回来，该单直接从结果里消失，其余各单的相对顺序不受影响（不会留空洞）。
 * 这是有意的：宁可少一行，也不能把已经不该看见的单导出去。
 */
export async function fetchOrdersInChunks<T>(
  client: PrismaClient,
  args: OrderExportFetchArgs,
  chunkSize: number = ORDER_EXPORT_CHUNK_SIZE,
): Promise<T[]> {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`fetchOrdersInChunks: chunkSize 必须是正整数，收到 ${chunkSize}`);
  }

  // 第一步：只取 id，拿到完整集合与权威顺序（orderBy 只在这一步生效）。
  const idRows = await client.order.findMany({
    where: args.where,
    orderBy: args.orderBy,
    select: { id: true },
  });
  const ids = idRows.map((row) => row.id);
  if (ids.length === 0) return [];

  // 第二步：按 id 切片取回实体。每批各自是一份独立的小结果，不会撞 napi 上限。
  // where 要**连同原条件一起带上**（AND 交集），不能只按 id 取：agentScope / 软删 / 状态
  // 这些闸都在原 where 里，只按 id 取等于把两步之间发生的越权与状态变更全部放行。
  // orderBy 这一步不带：`id in` 的返回顺序由数据库决定，反正第三步按第一步的 id 顺序重排。
  const byId = new Map<string, T>();
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const slice = ids.slice(offset, offset + chunkSize);
    const rows = (await client.order.findMany({
      where: { AND: [args.where, { id: { in: slice } }] },
      include: args.include,
    })) as unknown as Array<T & { id: string }>;
    for (const row of rows) byId.set(row.id, row);
  }

  // 第三步：按第一步的 id 顺序重排 —— `id in` 的返回顺序由数据库决定，不重排就会乱序。
  const ordered: T[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row !== undefined) ordered.push(row);
  }
  return ordered;
}
