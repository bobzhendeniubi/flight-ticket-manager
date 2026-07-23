/**
 * 履约任务 zod schema · 纯单测（vitest）
 *
 * 关注点：批量改备注 body 校验（taskIds 1-100 条 / notes 允许空串清空 / 超上限拒绝）+
 * 列表查询 notesQuery 筛选参数校验。
 */
import { describe, it, expect } from 'vitest';
import {
  batchFulfillmentNotesBodySchema,
  batchVisaTaskCostBodySchema,
  listFulfillmentQuerySchema,
  updateFulfillmentBodySchema,
} from './fulfillment.schemas.js';

describe('updateFulfillmentBodySchema — 签证金额字段', () => {
  it('接受 USD/汇率/CNY 三字段（含 null 清空）', () => {
    const parsed = updateFulfillmentBodySchema.parse({
      visaUnitCostUsd: 31.5,
      visaFxRate: 7.2,
      visaUnitCostCny: null,
    });
    expect(parsed.visaUnitCostUsd).toBe(31.5);
    expect(parsed.visaFxRate).toBe(7.2);
    expect(parsed.visaUnitCostCny).toBeNull();
  });

  it('拒绝负数单价与非正汇率', () => {
    expect(updateFulfillmentBodySchema.safeParse({ visaUnitCostUsd: -1 }).success).toBe(false);
    expect(updateFulfillmentBodySchema.safeParse({ visaFxRate: 0 }).success).toBe(false);
    expect(updateFulfillmentBodySchema.safeParse({ visaUnitCostCny: -0.01 }).success).toBe(false);
  });
});

describe('batchVisaTaskCostBodySchema — 批量设金额', () => {
  it('接受 taskIds + 成本字段', () => {
    const parsed = batchVisaTaskCostBodySchema.parse({
      taskIds: ['t1', 't2'],
      visaUnitCostCny: 200,
    });
    expect(parsed.taskIds).toEqual(['t1', 't2']);
    expect(parsed.visaUnitCostCny).toBe(200);
  });

  it('拒绝空 taskIds 与超上限（>100）', () => {
    expect(batchVisaTaskCostBodySchema.safeParse({ taskIds: [], visaUnitCostCny: 1 }).success).toBe(
      false,
    );
    const tooMany = Array.from({ length: 101 }, (_, i) => `t${i}`);
    expect(
      batchVisaTaskCostBodySchema.safeParse({ taskIds: tooMany, visaUnitCostCny: 1 }).success,
    ).toBe(false);
  });
});

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

describe('listFulfillmentQuerySchema — status 多状态', () => {
  it('单状态（老调用）→ 归一成单元素数组，向后兼容', () => {
    const parsed = listFulfillmentQuerySchema.parse({ status: 'PENDING' });
    expect(parsed.status).toEqual(['PENDING']);
  });

  it('逗号分隔多状态 → 数组（签证台「待办」= 待处理 + 材料准备）', () => {
    const parsed = listFulfillmentQuerySchema.parse({ status: 'PENDING,IN_PROGRESS' });
    expect(parsed.status).toEqual(['PENDING', 'IN_PROGRESS']);
  });

  it('重复 query 参数（?status=A&status=B）→ 数组', () => {
    const parsed = listFulfillmentQuerySchema.parse({ status: ['PENDING', 'CONFIRMED'] });
    expect(parsed.status).toEqual(['PENDING', 'CONFIRMED']);
  });

  it('逗号串带空白 → trim 后仍解析', () => {
    const parsed = listFulfillmentQuerySchema.parse({ status: ' PENDING , IN_PROGRESS ' });
    expect(parsed.status).toEqual(['PENDING', 'IN_PROGRESS']);
  });

  it('省略 / 空串 → undefined（「全部状态」不加条件）', () => {
    expect(listFulfillmentQuerySchema.parse({}).status).toBeUndefined();
    expect(listFulfillmentQuerySchema.parse({ status: '' }).status).toBeUndefined();
  });

  it('非法状态值 → 拒绝（不静默丢弃）', () => {
    expect(listFulfillmentQuerySchema.safeParse({ status: 'NOT_A_STATUS' }).success).toBe(false);
    expect(listFulfillmentQuerySchema.safeParse({ status: 'PENDING,NOPE' }).success).toBe(false);
  });
});

describe('listFulfillmentQuerySchema — issuanceMethod / departureDate', () => {
  it('issuanceMethod 接受签发方式枚举与 NONE（未标注）', () => {
    expect(listFulfillmentQuerySchema.parse({ issuanceMethod: 'E_VISA' }).issuanceMethod).toBe(
      'E_VISA',
    );
    expect(listFulfillmentQuerySchema.parse({ issuanceMethod: 'NONE' }).issuanceMethod).toBe('NONE');
  });

  it('issuanceMethod 非法值 → 拒绝', () => {
    expect(listFulfillmentQuerySchema.safeParse({ issuanceMethod: 'BOGUS' }).success).toBe(false);
  });

  it('departureDate 接受 YYYY-MM-DD，其他格式拒绝', () => {
    expect(listFulfillmentQuerySchema.parse({ departureDate: '2026-07-20' }).departureDate).toBe(
      '2026-07-20',
    );
    expect(listFulfillmentQuerySchema.safeParse({ departureDate: '2026/07/20' }).success).toBe(false);
    expect(listFulfillmentQuerySchema.safeParse({ departureDate: '20260720' }).success).toBe(false);
  });

  it('两者省略 → undefined（不筛）', () => {
    const parsed = listFulfillmentQuerySchema.parse({});
    expect(parsed.issuanceMethod).toBeUndefined();
    expect(parsed.departureDate).toBeUndefined();
  });
});
