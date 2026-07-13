/**
 * 履约任务 zod schema · 纯单测（vitest）
 *
 * 关注点：批量改备注 body 校验（taskIds 1-100 条 / notes 允许空串清空 / 超上限拒绝）+
 * 列表查询 notesQuery 筛选参数校验。
 */
import { describe, it, expect } from 'vitest';
import {
  batchFulfillmentNotesBodySchema,
  listFulfillmentQuerySchema,
} from './fulfillment.schemas.js';

describe('batchFulfillmentNotesBodySchema', () => {
  it('接受合法 taskIds + notes', () => {
    const parsed = batchFulfillmentNotesBodySchema.parse({
      taskIds: ['t1', 't2'],
      notes: '已联系客人补材料',
    });
    expect(parsed.taskIds).toEqual(['t1', 't2']);
    expect(parsed.notes).toBe('已联系客人补材料');
  });

  it('notes 允许空串（= 批量清空备注）', () => {
    const parsed = batchFulfillmentNotesBodySchema.parse({ taskIds: ['t1'], notes: '' });
    expect(parsed.notes).toBe('');
  });

  it('拒绝空 taskIds 数组', () => {
    const result = batchFulfillmentNotesBodySchema.safeParse({ taskIds: [], notes: '备注' });
    expect(result.success).toBe(false);
  });

  it('超量拒绝：taskIds 超过 100 条', () => {
    const taskIds = Array.from({ length: 101 }, (_, i) => `t${i}`);
    const result = batchFulfillmentNotesBodySchema.safeParse({ taskIds, notes: '备注' });
    expect(result.success).toBe(false);
  });

  it('taskIds 恰好 100 条 → 接受', () => {
    const taskIds = Array.from({ length: 100 }, (_, i) => `t${i}`);
    const result = batchFulfillmentNotesBodySchema.safeParse({ taskIds, notes: '备注' });
    expect(result.success).toBe(true);
  });

  it('拒绝 notes 超过 1000 字', () => {
    const result = batchFulfillmentNotesBodySchema.safeParse({
      taskIds: ['t1'],
      notes: 'x'.repeat(1001),
    });
    expect(result.success).toBe(false);
  });

  it('缺失 taskIds / notes 字段 → 拒绝', () => {
    expect(batchFulfillmentNotesBodySchema.safeParse({ notes: '备注' }).success).toBe(false);
    expect(batchFulfillmentNotesBodySchema.safeParse({ taskIds: ['t1'] }).success).toBe(false);
  });
});

describe('listFulfillmentQuerySchema — notesQuery', () => {
  it('notesQuery 省略 → undefined（不筛）', () => {
    const parsed = listFulfillmentQuerySchema.parse({});
    expect(parsed.notesQuery).toBeUndefined();
  });

  it('notesQuery 接受合法子串', () => {
    const parsed = listFulfillmentQuerySchema.parse({ notesQuery: '补材料' });
    expect(parsed.notesQuery).toBe('补材料');
  });

  it('notesQuery 超过 100 字 → 拒绝', () => {
    const result = listFulfillmentQuerySchema.safeParse({ notesQuery: 'x'.repeat(101) });
    expect(result.success).toBe(false);
  });
});
