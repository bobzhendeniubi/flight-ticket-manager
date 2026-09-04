/**
 * 编辑距离（Levenshtein）—— 「订正错别字」与「换人」之间那把尺。
 *
 * 为什么需要它：护照 OCR 把 Q 读成 0 / 5、把 O 读成 D 是常态，运营发现后改的是**同一个人**的
 * 证件号；而「换人」是另一个人上飞机 —— 两件事在数据上都表现为「documentNumber 变了」，
 * 但业务后果天差地别（换人要清护照图/签证/票号、要重开票、要重新送签）。
 * 用编辑距离给出一个客观分界：改动 ≤ N 个字符 = 录错字，超过 = 换了个人，走换人通道。
 *
 * 实现取滚动数组（O(min(m,n)) 空间）；证件号最长 60 字符，性能无需再优化。
 * 大小写由调用方先归一（证件号大小写不敏感），本函数按码位逐字比较。
 */

/** 「订正」允许的最大证件号改动字符数（超过即判为换人）。 */
export const TYPO_MAX_EDIT_DISTANCE = 2;

/**
 * 两个字符串的 Levenshtein 编辑距离（增/删/改各记 1）。
 *
 * @param limit 可选早停上限：某一行的最小值已超过 limit 时直接返回 limit + 1
 *              （调用方只关心「是否超过阈值」，不需要精确的大距离值）。
 */
export function levenshteinDistance(a: string, b: string, limit?: number): number {
  if (a === b) return 0;
  const source = [...a];
  const target = [...b];
  if (source.length === 0) return target.length;
  if (target.length === 0) return source.length;

  let previous = Array.from({ length: target.length + 1 }, (_, i) => i);
  let current = new Array<number>(target.length + 1);

  for (let i = 1; i <= source.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= target.length; j += 1) {
      const substitutionCost = source[i - 1] === target[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1, // 插入
        previous[j] + 1, // 删除
        previous[j - 1] + substitutionCost, // 替换
      );
      if (current[j] < rowMin) rowMin = current[j];
    }
    // 早停：整行都已超过上限，后续只会更大（编辑距离随行数单调不减）。
    if (limit !== undefined && rowMin > limit) return limit + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[target.length];
}
