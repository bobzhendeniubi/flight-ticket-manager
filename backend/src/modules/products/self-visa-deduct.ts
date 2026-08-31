/**
 * 自备签减免费率解析 —— 「null = 跟随签证组件产品价」（2026-08-30 价格收敛拍板）。
 *
 * 此前 ¥240 散在每个套餐的 selfVisaDeductCny 里，签证改价要挨个套餐改、改漏就漂。
 * 现在签证产品价（Visa.basePrice，含加急档位的基准价）是唯一价格源：
 *   套餐 selfVisaDeductCny = null → 取该套餐全部 VISA 组件的 basePrice 合计（每人一份）；
 *   非 null（含 0）→ 套餐自有覆盖，原样生效（特价团显式不减/另定额）。
 *
 * 语义与 Bundle.businessUpgradeCnyPerLeg 的「null = 跟随航班」同构。
 * 解析结果喂给 computeBundleAddOn（纯函数仍只认 number），订单行快照落的是解析后的数——
 * 下游改档/改自备签读快照费率的口径不变。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../db/prisma.js';

type Db = Prisma.TransactionClient | PrismaClient;

/** bundle.items JSON 里的 VISA 组件 visaId 列表（结构不合法一律当无组件，减免按 0 算）。 */
export function bundleVisaIds(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const ids: string[] = [];
  for (const rec of items) {
    if (
      rec != null &&
      typeof rec === 'object' &&
      (rec as { kind?: unknown }).kind === 'VISA' &&
      typeof (rec as { visaId?: unknown }).visaId === 'string' &&
      (rec as { visaId: string }).visaId
    ) {
      ids.push((rec as { visaId: string }).visaId);
    }
  }
  return ids;
}

/** 单套餐解析：显式值直接用；null → 查签证组件产品价合计。 */
export async function resolveSelfVisaDeductCny(
  bundle: { selfVisaDeductCny: number | null; items: unknown },
  db: Db = prisma,
): Promise<number> {
  if (bundle.selfVisaDeductCny != null) {
    return Math.max(0, Math.trunc(bundle.selfVisaDeductCny));
  }
  const visaIds = bundleVisaIds(bundle.items);
  if (visaIds.length === 0) return 0;
  const visas = await db.visa.findMany({
    where: { id: { in: visaIds } },
    select: { basePrice: true },
  });
  const total = visas.reduce((sum, v) => sum + Number(v.basePrice.toString()), 0);
  return Math.max(0, Math.trunc(total));
}

/**
 * 批量解析（列表序列化用）：一次查全所有「跟随」套餐涉及的签证产品价，避免逐套餐 N+1。
 * 返回 bundleId → 有效减免费率。
 */
export async function resolveSelfVisaDeductCnyBatch(
  bundles: ReadonlyArray<{ id: string; selfVisaDeductCny: number | null; items: unknown }>,
  db: Db = prisma,
): Promise<Map<string, number>> {
  const idsByBundle = new Map<string, string[]>();
  const allVisaIds = new Set<string>();
  for (const b of bundles) {
    if (b.selfVisaDeductCny != null) continue;
    const ids = bundleVisaIds(b.items);
    idsByBundle.set(b.id, ids);
    ids.forEach((id) => allVisaIds.add(id));
  }
  const priceById = new Map<string, number>();
  if (allVisaIds.size > 0) {
    const visas = await db.visa.findMany({
      where: { id: { in: [...allVisaIds] } },
      select: { id: true, basePrice: true },
    });
    for (const v of visas) priceById.set(v.id, Number(v.basePrice.toString()));
  }
  const out = new Map<string, number>();
  for (const b of bundles) {
    if (b.selfVisaDeductCny != null) {
      out.set(b.id, Math.max(0, Math.trunc(b.selfVisaDeductCny)));
    } else {
      const sum = (idsByBundle.get(b.id) ?? []).reduce((s, id) => s + (priceById.get(id) ?? 0), 0);
      out.set(b.id, Math.max(0, Math.trunc(sum)));
    }
  }
  return out;
}
