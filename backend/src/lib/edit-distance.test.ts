/**
 * 编辑距离 · 单测
 *
 * 这把尺决定「订正错别字」与「换人」的分界（correctPassenger 的闸②），
 * 所以真实场景（护照 OCR 的字符误读）必须逐条钉死。
 */
import { describe, it, expect } from 'vitest';
import { levenshteinDistance, TYPO_MAX_EDIT_DISTANCE } from './edit-distance.js';

describe('levenshteinDistance', () => {
  it('完全相同 → 0', () => {
    expect(levenshteinDistance('E12345678', 'E12345678')).toBe(0);
    expect(levenshteinDistance('', '')).toBe(0);
  });

  it('一端为空 → 另一端的长度', () => {
    expect(levenshteinDistance('', 'ABC')).toBe(3);
    expect(levenshteinDistance('ABC', '')).toBe(3);
  });

  it('替换 / 插入 / 删除各记 1', () => {
    expect(levenshteinDistance('E12345678', 'E12345078')).toBe(1); // 替换
    expect(levenshteinDistance('E1234567', 'E12345678')).toBe(1); // 插入
    expect(levenshteinDistance('E12345678', 'E1234568')).toBe(1); // 删除
  });

  it('对称（两个方向同一个数）', () => {
    expect(levenshteinDistance('EA9012345', 'E9012345')).toBe(
      levenshteinDistance('E9012345', 'EA9012345'),
    );
  });

  // 护照 OCR 的典型误读：Q↔0、Q↔5、O↔D，都落在 1 个字符内。
  it.each([
    ['E12345Q78', 'E12345078'],
    ['E12345Q78', 'E12345578'],
    ['EO123456', 'ED123456'],
  ])('OCR 单字符误读 %s → %s 的距离在阈值内', (a, b) => {
    expect(levenshteinDistance(a, b)).toBeLessThanOrEqual(TYPO_MAX_EDIT_DISTANCE);
  });

  it('换成另一本护照 → 远超阈值', () => {
    expect(levenshteinDistance('E12345678', 'G98765432')).toBeGreaterThan(TYPO_MAX_EDIT_DISTANCE);
  });

  it('early-stop 上限：超过上限只保证返回 limit+1，判阈值的结论不变', () => {
    const withLimit = levenshteinDistance('E12345678', 'G98765432', TYPO_MAX_EDIT_DISTANCE);
    expect(withLimit).toBe(TYPO_MAX_EDIT_DISTANCE + 1);
    // 未超上限时，带不带 limit 结果一致
    expect(levenshteinDistance('E12345678', 'E12345078', TYPO_MAX_EDIT_DISTANCE)).toBe(1);
    expect(levenshteinDistance('E12345678', 'E12340078', TYPO_MAX_EDIT_DISTANCE)).toBe(2);
  });

  it('按码位比较，不被多字节字符切坏', () => {
    expect(levenshteinDistance('张三', '张叁')).toBe(1);
  });
});
