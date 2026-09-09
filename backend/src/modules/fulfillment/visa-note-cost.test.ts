import { describe, it, expect } from 'vitest';
import {
  parseVisaNoteCost,
  isAmountOnlySupplier,
  parseAmountOnlySupplier,
} from './visa-note-cost.js';

describe('parseVisaNoteCost', () => {
  it('标准写法「<签证公司><金额>美金」按公司名 + 金额读出', () => {
    expect(parseVisaNoteCost('斯玛特31.5美金')).toEqual({ supplier: '斯玛特', usd: 31.5 });
    expect(parseVisaNoteCost('斯玛特65美金')).toEqual({ supplier: '斯玛特', usd: 65 });
    expect(parseVisaNoteCost('斯玛特39美金')).toEqual({ supplier: '斯玛特', usd: 39 });
    expect(parseVisaNoteCost('林总54美金')).toEqual({ supplier: '林总', usd: 54 });
    expect(parseVisaNoteCost('林总58美金')).toEqual({ supplier: '林总', usd: 58 });
    expect(parseVisaNoteCost('斯玛特85美金')).toEqual({ supplier: '斯玛特', usd: 85 });
    expect(parseVisaNoteCost('林总55美金')).toEqual({ supplier: '林总', usd: 55 });
    expect(parseVisaNoteCost('斯玛特15美金')).toEqual({ supplier: '斯玛特', usd: 15 });
    expect(parseVisaNoteCost('斯玛特51美金')).toEqual({ supplier: '斯玛特', usd: 51 });
    expect(parseVisaNoteCost('斯玛特45美金')).toEqual({ supplier: '斯玛特', usd: 45 });
    expect(parseVisaNoteCost('斯玛特70美金')).toEqual({ supplier: '斯玛特', usd: 70 });
    expect(parseVisaNoteCost('斯玛特42.5美金')).toEqual({ supplier: '斯玛特', usd: 42.5 });
    expect(parseVisaNoteCost('斯玛特95美金')).toEqual({ supplier: '斯玛特', usd: 95 });
  });

  it('金额后面的尾巴（系统追加说明）不影响取数', () => {
    expect(
      parseVisaNoteCost(
        '斯玛特15美金 · 由订单 FTM2026083068112 拆分创建 · 拆单漏承接签证任务，系统补建',
      ),
    ).toEqual({ supplier: '斯玛特', usd: 15 });
  });

  it('金额与「美金」之间允许空格', () => {
    expect(parseVisaNoteCost('斯玛特31.5 美金')).toEqual({ supplier: '斯玛特', usd: 31.5 });
  });

  it('首尾空白不影响匹配', () => {
    expect(parseVisaNoteCost('  斯玛特65美金  ')).toEqual({ supplier: '斯玛特', usd: 65 });
  });

  it('两段相加的写法金额口径不明，交人工', () => {
    expect(parseVisaNoteCost('斯玛特35+65美金')).toBeNull();
  });

  it('没有金额的备注不算', () => {
    expect(parseVisaNoteCost('斯玛特免费取消')).toBeNull();
    expect(parseVisaNoteCost('斯玛特')).toBeNull();
  });

  it('不是进价备注的文本一律不算', () => {
    expect(parseVisaNoteCost('自备签证*7  安排前置舱')).toBeNull();
    expect(
      parseVisaNoteCost('录单签证要求为「不需要」，全员自备签，纠错取消（2026-08-27）'),
    ).toBeNull();
  });

  it('没有公司名的纯金额备注不算（说不清这笔钱付给谁）', () => {
    expect(parseVisaNoteCost('31.5美金')).toBeNull();
    expect(parseVisaNoteCost('65 美金')).toBeNull();
  });

  it('公司名与金额之间不许有空格（隔开的就不是这套写法）', () => {
    expect(parseVisaNoteCost('斯玛特 31.5美金')).toBeNull();
    expect(parseVisaNoteCost('已送签 斯玛特65美金')).toBeNull();
  });

  it('金额前有别的词句（含空格）的不算', () => {
    expect(parseVisaNoteCost('客人 12 人，斯玛特31.5美金')).toBeNull();
  });

  it('非正数金额等同于没填', () => {
    expect(parseVisaNoteCost('斯玛特0美金')).toBeNull();
    expect(parseVisaNoteCost('斯玛特0.00美金')).toBeNull();
  });

  it('空备注返回 null', () => {
    expect(parseVisaNoteCost(null)).toBeNull();
    expect(parseVisaNoteCost(undefined)).toBeNull();
    expect(parseVisaNoteCost('')).toBeNull();
    expect(parseVisaNoteCost('   ')).toBeNull();
  });
});

describe('isAmountOnlySupplier', () => {
  it('被填成金额的签证公司格能认出来', () => {
    expect(isAmountOnlySupplier('31.5美金')).toBe(true);
    expect(isAmountOnlySupplier('65美金')).toBe(true);
    expect(isAmountOnlySupplier('54 美金')).toBe(true);
    expect(isAmountOnlySupplier('39美元')).toBe(true);
    expect(isAmountOnlySupplier('39USD')).toBe(true);
    expect(isAmountOnlySupplier('39 usd')).toBe(true);
    expect(isAmountOnlySupplier('39')).toBe(true);
    expect(isAmountOnlySupplier('  31.5美金 ')).toBe(true);
  });

  it('真正的公司名不算金额', () => {
    expect(isAmountOnlySupplier('斯玛特')).toBe(false);
    expect(isAmountOnlySupplier('林总')).toBe(false);
    expect(isAmountOnlySupplier('斯玛特31.5美金')).toBe(false);
    expect(isAmountOnlySupplier('35+65美金')).toBe(false);
  });

  it('空值不算', () => {
    expect(isAmountOnlySupplier(null)).toBe(false);
    expect(isAmountOnlySupplier(undefined)).toBe(false);
    expect(isAmountOnlySupplier('')).toBe(false);
    expect(isAmountOnlySupplier('   ')).toBe(false);
  });
});

describe('parseAmountOnlySupplier', () => {
  it('金额型的公司名读出美金金额', () => {
    expect(parseAmountOnlySupplier('31.5美金')).toBe(31.5);
    expect(parseAmountOnlySupplier('65')).toBe(65);
    expect(parseAmountOnlySupplier(' 54 美元 ')).toBe(54);
  });

  it('不是金额型 / 非正数 → null', () => {
    expect(parseAmountOnlySupplier('斯玛特')).toBeNull();
    expect(parseAmountOnlySupplier('0美金')).toBeNull();
    expect(parseAmountOnlySupplier(null)).toBeNull();
  });
});
