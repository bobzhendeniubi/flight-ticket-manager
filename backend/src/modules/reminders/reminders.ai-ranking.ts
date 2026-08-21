export interface AiRankedReminder {
  id: string;
  rank: number;
  reason: string;
}

const DEFAULT_RANK_REASON = '待处理';

function safeReason(reason: string): string {
  const trimmed = reason.trim();
  return Array.from(trimmed || DEFAULT_RANK_REASON).slice(0, 20).join('');
}

/**
 * 校验并归一化模型排序结果：只接收入参 ID、按 rank 稳定排序、去重，漏返项按原顺序补到末尾。
 * 该函数不依赖数据库，供路由和单元测试共同使用。
 */
export function validateRankedReminders(
  inputIds: string[],
  modelItems: AiRankedReminder[],
): AiRankedReminder[] {
  const inputIdSet = new Set(inputIds);
  const seenIds = new Set<string>();
  const valid: Array<AiRankedReminder & { sourceIndex: number }> = [];
  for (const [index, item] of modelItems.entries()) {
    if (!inputIdSet.has(item.id) || seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    valid.push({ ...item, reason: safeReason(item.reason), sourceIndex: index });
  }
  valid
    .sort((a, b) => a.rank - b.rank || a.sourceIndex - b.sourceIndex);

  const result: AiRankedReminder[] = valid.map((item, index) => ({
    id: item.id,
    rank: index + 1,
    reason: item.reason,
  }));
  const returnedIds = new Set(result.map((item) => item.id));

  for (const id of inputIds) {
    if (returnedIds.has(id)) continue;
    result.push({ id, rank: result.length + 1, reason: DEFAULT_RANK_REASON });
    returnedIds.add(id);
  }
  return result;
}
