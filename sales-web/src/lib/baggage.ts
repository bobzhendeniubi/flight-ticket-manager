import type { BaggagePolicyInfo } from './api';

/**
 * 行李额紧凑展示："托运 23kg·2件 / 手提 7kg"。
 * 后端按 航班×舱等 配置，kg / 件数可分别为空 —— 只拼有值的部分；
 * 全空返回 null（前端不渲染该行）。
 */
export function formatBaggage(b: BaggagePolicyInfo): string | null {
  const checkedParts = [
    b.checkedKg != null ? `${b.checkedKg}kg` : null,
    b.checkedPieces != null ? `${b.checkedPieces}件` : null,
  ].filter((p): p is string => p !== null);

  const parts: string[] = [];
  if (checkedParts.length > 0) parts.push(`托运 ${checkedParts.join('·')}`);
  if (b.carryOnKg != null) parts.push(`手提 ${b.carryOnKg}kg`);

  return parts.length > 0 ? parts.join(' / ') : null;
}
