/**
 * 档案合并链（mergedIntoId）的解析 —— 全站唯一一份纯函数。
 *
 * 谁在用：
 *   - traveler-profiles.service.ts：详情重算 / 全量重建 / 录单联想 / 核销挂单的证件比对；
 *   - traveler-benefits.auto-reverse.ts：订单取消 / no-show 自动冲正时，按「档案全部证件」
 *     比对单上乘客与仍有效的行程；
 *   - reminders.rules.trip-balance.ts：负数提醒扫描前按档案全部证件现算次数。
 *
 * 为什么独立成文件：service 依赖 benefits.service，benefits.service 依赖 auto-reverse ——
 * auto-reverse 再 import service 就成环。链解析只是几行纯函数，放在这里谁都能用。
 *
 * 链深不是常数：A→B 之后再 B→C 两次合并都合法（第二次开始时 B、C 都还是主档案），
 * 所以 A 的指针仍指着 B，而台账早已跟着人搬到 C。任何「只取一跳」的写法都会漏掉 A 的旧证。
 */
import type { DocumentType, PrismaClient } from '@prisma/client';
import { docKey } from './traveler-profiles.aggregate.js';

/** 链解析用到的最小档案行（全表小数据量，一次拉全量在内存里解析链）。 */
export interface ProfileRef {
  id: string;
  documentType: DocumentType;
  documentNumber: string;
  mergedIntoId: string | null;
}

export interface DocPair {
  documentType: DocumentType;
  documentNumber: string;
}

/**
 * 沿 mergedIntoId 链解析到最终主档案。
 * 断链（主档案被删）/ 环（脏数据）时停在当前行，不抛错不死循环。
 */
export function resolveMasterRef<T extends ProfileRef>(start: T, byId: Map<string, T>): T {
  let current = start;
  const seen = new Set<string>([current.id]);
  while (current.mergedIntoId) {
    const next = byId.get(current.mergedIntoId);
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    current = next;
  }
  return current;
}

/**
 * 从指针行构建别名索引：
 *   aliasMap           — 旧证 docKey → 主档案 docKey（喂给聚合做归拢）
 *   docPairsByMasterId — 主档案 id → 全部证件对（本证 + 并入的旧证，链上任意深度），查订单乘机人用
 */
export function buildAliasIndex<T extends ProfileRef>(byId: Map<string, T>): {
  aliasMap: Map<string, string>;
  docPairsByMasterId: Map<string, DocPair[]>;
} {
  const aliasMap = new Map<string, string>();
  const docPairsByMasterId = new Map<string, DocPair[]>();
  for (const ref of byId.values()) {
    if (ref.mergedIntoId === null) {
      docPairsByMasterId.set(ref.id, [
        { documentType: ref.documentType, documentNumber: ref.documentNumber },
      ]);
    }
  }
  for (const ref of byId.values()) {
    if (ref.mergedIntoId === null) continue;
    const master = resolveMasterRef(ref, byId);
    // 断链/环解析不到 canonical 行 → 该指针放弃归拢（只影响这一条，不拖垮整体）
    if (master.id === ref.id || master.mergedIntoId !== null) continue;
    aliasMap.set(
      docKey(ref.documentType, ref.documentNumber),
      docKey(master.documentType, master.documentNumber),
    );
    docPairsByMasterId
      .get(master.id)!
      .push({ documentType: ref.documentType, documentNumber: ref.documentNumber });
  }
  return { aliasMap, docPairsByMasterId };
}

/**
 * 某个档案 id（主档案或指针行皆可）→ 其主档案的全部证件对。
 * 解析不到（id 不在 refs 里）返回 null，由调用方决定兜底。
 */
export function docPairsForProfile<T extends ProfileRef>(
  profileId: string,
  refs: Map<string, T>,
  docPairsByMasterId: Map<string, DocPair[]>,
): DocPair[] | null {
  const ref = refs.get(profileId);
  if (!ref) return null;
  const master = resolveMasterRef(ref, refs);
  return (
    docPairsByMasterId.get(master.id) ?? [
      { documentType: master.documentType, documentNumber: master.documentNumber },
    ]
  );
}

/** 只用到 travelerProfile.findMany 的客户端（PrismaClient / TransactionClient 都行）。 */
export type ProfileRefClient = {
  travelerProfile: Pick<PrismaClient['travelerProfile'], 'findMany'>;
};

/** 全表最小行（含指针行），供链解析；内部量级（千级档案）一次拉全量可接受。 */
export async function loadProfileRefs(client: ProfileRefClient): Promise<Map<string, ProfileRef>> {
  const rows = await client.travelerProfile.findMany({
    select: { id: true, documentType: true, documentNumber: true, mergedIntoId: true },
  });
  return new Map(rows.map((r) => [r.id, r]));
}
