import { describe, expect, it } from 'vitest';
import {
  canRegisterPayment,
  diffSummary,
  fmtAmount,
  fmtCny,
  fmtMoney,
  payDisabledReason,
  payProgress,
  payProgressBarClass,
  payProgressLabel,
  payProgressTone,
} from './payablesView';
import type { ReconcileDiffLevel } from './payablesApi';

const LABEL: Record<ReconcileDiffLevel, string> = {
  MATCH: '对得上',
  MINOR: '小差异',
  MAJOR: '差异较大',
  NO_BASIS: '无系统侧口径',
};
const TONE: Record<ReconcileDiffLevel, string> = {
  MATCH: 'badge-success',
  MINOR: 'badge-warning',
  MAJOR: 'badge-danger',
  NO_BASIS: 'badge-neutral',
};

describe('payProgress —— 核销进度', () => {
  it('一分没付是 0，付满是 1', () => {
    expect(payProgress(0, 1000)).toBe(0);
    expect(payProgress(1000, 1000)).toBe(1);
  });

  it('付一半是 0.5', () => {
    expect(payProgress(500, 1000)).toBe(0.5);
  });

  it('付超了夹到 1 —— 进度条不画出格子外面', () => {
    expect(payProgress(1200, 1000)).toBe(1);
  });

  it('账单金额为 0 或负（脏数据）返回 0，不返回 NaN / Infinity', () => {
    expect(payProgress(100, 0)).toBe(0);
    expect(payProgress(100, -50)).toBe(0);
  });

  it('非数字返回 0，整行不因为一条烂数据崩掉', () => {
    expect(payProgress(Number.NaN, 1000)).toBe(0);
    expect(payProgress(100, Number.NaN)).toBe(0);
    expect(payProgress(Number.POSITIVE_INFINITY, 1000)).toBe(0);
  });

  it('负的已付（不该出现）当作 0', () => {
    expect(payProgress(-100, 1000)).toBe(0);
  });
});

describe('payProgressTone / payProgressBarClass —— 进度条配色', () => {
  it('付清=绿，动过钱=琥珀，一分没付=灰', () => {
    expect(payProgressTone(1000, 1000)).toBe('done');
    expect(payProgressTone(1, 1000)).toBe('partial');
    expect(payProgressTone(0, 1000)).toBe('none');
  });

  it('class 跟着 tone 走', () => {
    expect(payProgressBarClass(1000, 1000)).toBe('bg-emerald-500');
    expect(payProgressBarClass(400, 1000)).toBe('bg-amber-500');
    expect(payProgressBarClass(0, 1000)).toBe('bg-slate-300');
  });
});

describe('payProgressLabel —— 进度条底下那行字（按原币）', () => {
  it('外币按原币显示，百分比取整', () => {
    expect(payProgressLabel(1200, 3000, 'USD')).toBe('1,200.00 / 3,000.00 USD（40%）');
  });

  it('付清显示 100%', () => {
    expect(payProgressLabel(3000, 3000, 'USD')).toBe('3,000.00 / 3,000.00 USD（100%）');
  });
});

describe('金额格式化', () => {
  it('fmtAmount 两位小数带千分位', () => {
    expect(fmtAmount(1234.5)).toBe('1,234.50');
    expect(fmtAmount(0)).toBe('0.00');
  });

  it('fmtCny 带 ¥；空值与非数字给破折号而不是 NaN', () => {
    expect(fmtCny(1234.5)).toBe('¥1,234.50');
    expect(fmtCny(null)).toBe('—');
    expect(fmtCny(undefined)).toBe('—');
    expect(fmtCny(Number.NaN)).toBe('—');
  });

  it('fmtMoney：人民币用 ¥ 前缀，外币把币种放后面', () => {
    expect(fmtMoney(1200, 'CNY')).toBe('¥1,200.00');
    expect(fmtMoney(1200, 'USD')).toBe('1,200.00 USD');
  });
});

describe('diffSummary —— 差额一句话（级别由后端定，这里只翻译）', () => {
  it('无系统侧口径时不编造差额', () => {
    const s = diffSummary('NO_BASIS', null, null, LABEL, TONE);
    expect(s.label).toBe('无系统侧口径');
    expect(s.tone).toBe('badge-neutral');
    expect(s.text).toBe('系统侧没有可比金额');
    expect(s.hint).toContain('产品还没挂');
  });

  it('账单比系统多 —— 正差额说「多」，百分比带 +', () => {
    const s = diffSummary('MINOR', 1234, 0.041, LABEL, TONE);
    expect(s.text).toBe('账单比系统多 ¥1,234.00（+4.1%）');
    expect(s.tone).toBe('badge-warning');
  });

  it('账单比系统少 —— 负差额说「少」，金额取绝对值', () => {
    const s = diffSummary('MAJOR', -8000, -0.12, LABEL, TONE);
    expect(s.text).toBe('账单比系统少 ¥8,000.00（-12.0%）');
    expect(s.tone).toBe('badge-danger');
  });

  it('差额小于半分算一致', () => {
    expect(diffSummary('MATCH', 0.001, 0, LABEL, TONE).text).toBe('两边一致（+0.0%）');
    expect(diffSummary('MATCH', 0, null, LABEL, TONE).text).toBe('两边一致');
  });

  it('每一级都带一句「下一步怎么办」', () => {
    expect(diffSummary('MATCH', 0, 0, LABEL, TONE).hint).toContain('可以确认账单');
    expect(diffSummary('MAJOR', 9999, 0.5, LABEL, TONE).hint).toContain('先别付');
  });

  it('级别原样透传，前端不自己判', () => {
    // 同一笔差额，后端说是 MATCH 就是 MATCH——阈值只有后端一份
    expect(diffSummary('MATCH', 5000, 0.004, LABEL, TONE).level).toBe('MATCH');
    expect(diffSummary('MAJOR', 5000, 0.004, LABEL, TONE).level).toBe('MAJOR');
  });
});

describe('canRegisterPayment / payDisabledReason —— 付款按钮显隐与灰掉的理由', () => {
  it('与后端同一套：草稿与争议不能付', () => {
    expect(canRegisterPayment('DRAFT')).toBe(false);
    expect(canRegisterPayment('DISPUTED')).toBe(false);
    expect(canRegisterPayment('CONFIRMED')).toBe(true);
    expect(canRegisterPayment('PARTIALLY_PAID')).toBe(true);
    expect(canRegisterPayment('PAID')).toBe(true);
  });

  it('灰掉时把原因写出来，别让运营去猜', () => {
    expect(payDisabledReason('DRAFT')).toContain('确认账单');
    expect(payDisabledReason('DISPUTED')).toContain('已确认');
    expect(payDisabledReason('CONFIRMED')).toBeNull();
    expect(payDisabledReason('PAID')).toBeNull();
  });
});
