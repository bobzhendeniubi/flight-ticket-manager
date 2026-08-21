import { describe, expect, it } from 'vitest';
import { validateRankedReminders, type AiRankedReminder } from './reminders.ai-ranking.js';

describe('提醒排序结果校验', () => {
  it('模型漏返提醒时按入参顺序补回，提醒不会消失', () => {
    const result = validateRankedReminders(['rem-a', 'rem-b', 'rem-c'], [
      { id: 'rem-b', rank: 1, reason: '金额较高' },
    ]);

    expect(result).toEqual([
      { id: 'rem-b', rank: 1, reason: '金额较高' },
      { id: 'rem-a', rank: 2, reason: '待处理' },
      { id: 'rem-c', rank: 3, reason: '待处理' },
    ]);
  });

  it('模型返回入参之外的提醒时丢弃多余 id', () => {
    const result = validateRankedReminders(['rem-a', 'rem-b'], [
      { id: 'rem-outside', rank: 1, reason: '不应出现' },
      { id: 'rem-b', rank: 2, reason: '临近截止' },
    ]);

    expect(result.map((item) => item.id)).toEqual(['rem-b', 'rem-a']);
    expect(result.some((item) => item.id === 'rem-outside')).toBe(false);
  });

  it('模型数组顺序混乱时按 rank 排序并重新编号', () => {
    const modelResult: AiRankedReminder[] = [
      { id: 'rem-c', rank: 3, reason: '影响履约' },
      { id: 'rem-a', rank: 1, reason: '今天到期' },
      { id: 'rem-b', rank: 2, reason: '金额较高' },
    ];

    expect(validateRankedReminders(['rem-a', 'rem-b', 'rem-c'], modelResult)).toEqual([
      { id: 'rem-a', rank: 1, reason: '今天到期' },
      { id: 'rem-b', rank: 2, reason: '金额较高' },
      { id: 'rem-c', rank: 3, reason: '影响履约' },
    ]);
  });

  it('模型重复返回同一个提醒时只保留首次出现的结果和理由', () => {
    const result = validateRankedReminders(['rem-a', 'rem-b'], [
      { id: 'rem-b', rank: 1, reason: '先处理' },
      { id: 'rem-b', rank: 2, reason: '后处理' },
      { id: 'rem-a', rank: 3, reason: '金额较低' },
    ]);

    expect(result).toEqual([
      { id: 'rem-b', rank: 1, reason: '先处理' },
      { id: 'rem-a', rank: 2, reason: '金额较低' },
    ]);
  });
});
