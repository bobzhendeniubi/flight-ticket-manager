import { describe, expect, it } from 'vitest';
import {
  findUnauthorizedHardData,
  renderDraftTemplate,
  type DraftHardFacts,
} from './reminders.ai-draft.js';

const FACTS: DraftHardFacts = {
  orderNumber: 'FTM202608190001',
  amount: '3000',
  totalAmount: '5000',
  paidAmount: '2000',
  dueDate: '2026-08-20',
  departureDate: '2026-08-25',
};

describe('催办话术模板安全校验', () => {
  it('用数据库真值替换占位符', () => {
    expect(
      renderDraftTemplate(
        '订单 {{orderNumber}} 尚有 {{amount}} 元尾款，请于 {{dueDate}} 前处理。',
        FACTS,
      ),
    ).toEqual({
      ok: true,
      text: '订单 FTM202608190001 尚有 3000 元尾款，请于 2026-08-20 前处理。',
    });
  });

  it('检测占位符之外的金额、日期和订单号样式内容', () => {
    expect(findUnauthorizedHardData('订单 FTM202699999999 尚有 ¥9999 元，请于 2026-09-01 处理')).toBe(
      '包含未授权的数字或日期',
    );
    expect(renderDraftTemplate('请在三千元到账后确认。', FACTS)).toEqual({
      ok: false,
      reason: '包含未授权的中文金额',
    });
  });

  it('拒绝未知或没有数据库真值的占位符', () => {
    expect(renderDraftTemplate('订单 {{unknown}} 请处理。', FACTS)).toEqual({
      ok: false,
      reason: '包含未知占位符 {{unknown}}',
    });
    expect(
      renderDraftTemplate('请于 {{dueDate}} 前处理。', { ...FACTS, dueDate: null }),
    ).toEqual({
      ok: false,
      reason: '使用了未提供的占位符 {{dueDate}}',
    });
  });
});
