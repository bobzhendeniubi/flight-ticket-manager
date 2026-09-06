/**
 * 供应商应付 · 纯函数单测（mock Prisma，不依赖真 DB）
 *
 * 钉的是四条口径，它们各自都有一个「一改就出事」的具体后果：
 *   1. 核销状态推导 —— 人工态（草稿 / 争议）绝不因为付款自动跳走，否则一笔误录的付款
 *      能把「挂起不付」的争议单悄悄转成已付清。
 *   2. 币种折算 —— 人民币账单不许带汇率、外币账单必须带，否则 CNY 入账数会静默错一个数量级。
 *   3. 期次归一 —— 按月账单的区间必须是该月闭区间（含末日），差一天就会漏掉月底那笔成本。
 *   4. 对账差额分级 —— 无系统侧口径要标 NO_BASIS 而不是「差了一整张账单」，
 *      否则每张没挂供应商的账单都会红成大差异，财务很快就不看这个标了。
 */
import { describe, expect, it, vi } from 'vitest';
import { SupplierInvoiceStatus } from '@prisma/client';

// 本文件只测纯函数，但服务模块在 import 时会拉起 prisma 单例——给个不会连库的替身
vi.mock('../../db/prisma.js', () => ({ prisma: {} }));

import {
  canRegisterPayment,
  convertToCny,
  deriveInvoiceStatus,
  fmtDateOnly,
  monthToRange,
  round2,
  toDateOnly,
} from './supplier-invoices.service.js';
import { diffLevel, overlapNights } from './supplier-payables.reconcile.js';

describe('deriveInvoiceStatus —— 核销状态推导', () => {
  it('草稿态不因为付款而改变（草稿本来就不许挂付款）', () => {
    expect(deriveInvoiceStatus(SupplierInvoiceStatus.DRAFT, 0, 1000)).toBe(
      SupplierInvoiceStatus.DRAFT,
    );
    expect(deriveInvoiceStatus(SupplierInvoiceStatus.DRAFT, 1000, 1000)).toBe(
      SupplierInvoiceStatus.DRAFT,
    );
  });

  it('争议单即使付满也不会被推成已付清 —— 挂起不付就是挂起不付', () => {
    expect(deriveInvoiceStatus(SupplierInvoiceStatus.DISPUTED, 1000, 1000)).toBe(
      SupplierInvoiceStatus.DISPUTED,
    );
  });

  it('已确认 + 零付款 = 已确认', () => {
    expect(deriveInvoiceStatus(SupplierInvoiceStatus.CONFIRMED, 0, 1000)).toBe(
      SupplierInvoiceStatus.CONFIRMED,
    );
  });

  it('付了一部分 → 部分付款', () => {
    expect(deriveInvoiceStatus(SupplierInvoiceStatus.CONFIRMED, 400, 1000)).toBe(
      SupplierInvoiceStatus.PARTIALLY_PAID,
    );
  });

  it('付满 → 已付清', () => {
    expect(deriveInvoiceStatus(SupplierInvoiceStatus.CONFIRMED, 1000, 1000)).toBe(
      SupplierInvoiceStatus.PAID,
    );
  });

  it('差半分之内视为付清 —— 不让浮点尾巴把「刚好付清」判成没付完', () => {
    expect(deriveInvoiceStatus(SupplierInvoiceStatus.CONFIRMED, 999.997, 1000)).toBe(
      SupplierInvoiceStatus.PAID,
    );
  });

  it('撤销付款会让已付清退回去（同一个函数反着走一遍）', () => {
    // 撤掉最后一笔：付款合计从 1000 掉到 600
    expect(deriveInvoiceStatus(SupplierInvoiceStatus.PAID, 600, 1000)).toBe(
      SupplierInvoiceStatus.PARTIALLY_PAID,
    );
    // 全撤光 → 回到已确认
    expect(deriveInvoiceStatus(SupplierInvoiceStatus.PAID, 0, 1000)).toBe(
      SupplierInvoiceStatus.CONFIRMED,
    );
  });
});

describe('canRegisterPayment —— 哪些状态能登记付款', () => {
  it('草稿与争议一律拒（fail-closed）', () => {
    expect(canRegisterPayment(SupplierInvoiceStatus.DRAFT)).toBe(false);
    expect(canRegisterPayment(SupplierInvoiceStatus.DISPUTED)).toBe(false);
  });

  it('已确认 / 部分付款 / 已付清可以登记', () => {
    expect(canRegisterPayment(SupplierInvoiceStatus.CONFIRMED)).toBe(true);
    expect(canRegisterPayment(SupplierInvoiceStatus.PARTIALLY_PAID)).toBe(true);
    // 已付清仍放行：金额调高后要能补付，闸交给「超付直接拒」那道
    expect(canRegisterPayment(SupplierInvoiceStatus.PAID)).toBe(true);
  });
});

describe('convertToCny —— 原币折人民币', () => {
  it('人民币账单原样返回', () => {
    expect(convertToCny(1234.567, 'CNY', null)).toBe(1234.57);
  });

  it('人民币账单填了汇率直接拒（口径混乱早发现）', () => {
    expect(() => convertToCny(1000, 'CNY', 7.1)).toThrow();
  });

  it('人民币账单填 1 是允许的（等价于没填）', () => {
    expect(convertToCny(1000, 'CNY', 1)).toBe(1000);
  });

  it('外币账单不填汇率直接拒', () => {
    expect(() => convertToCny(1000, 'USD', null)).toThrow();
  });

  it('外币账单按汇率折算并保留两位', () => {
    expect(convertToCny(1000, 'USD', 7.123)).toBe(7123);
    expect(convertToCny(333.33, 'USD', 7.1)).toBe(2366.64);
  });

  it('汇率必须为正', () => {
    expect(() => convertToCny(1000, 'USD', 0)).toThrow();
    expect(() => convertToCny(1000, 'USD', -7)).toThrow();
  });
});

describe('monthToRange —— 按月账单的期次区间', () => {
  it('是该月的闭区间，含末日', () => {
    const { from, to } = monthToRange('2026-09');
    expect(fmtDateOnly(from)).toBe('2026-09-01');
    expect(fmtDateOnly(to)).toBe('2026-09-30');
  });

  it('31 天的月份取到 31 号', () => {
    expect(fmtDateOnly(monthToRange('2026-01').to)).toBe('2026-01-31');
  });

  it('闰年二月取到 29 号', () => {
    expect(fmtDateOnly(monthToRange('2028-02').to)).toBe('2028-02-29');
  });

  it('平年二月取到 28 号', () => {
    expect(fmtDateOnly(monthToRange('2026-02').to)).toBe('2026-02-28');
  });

  it('格式不对直接拒', () => {
    expect(() => monthToRange('2026-9')).toThrow();
    expect(() => monthToRange('2026-13')).toThrow();
  });
});

describe('toDateOnly —— @db.Date 列按字面日期存，不折时区', () => {
  it('转出来是 UTC 午夜，回读仍是同一天', () => {
    expect(toDateOnly('2026-09-06').toISOString()).toBe('2026-09-06T00:00:00.000Z');
    expect(fmtDateOnly(toDateOnly('2026-09-06'))).toBe('2026-09-06');
  });

  it('格式不对直接拒', () => {
    expect(() => toDateOnly('2026/09/06')).toThrow();
    expect(() => toDateOnly('26-09-06')).toThrow();
  });
});

describe('round2', () => {
  it('四舍五入到分', () => {
    expect(round2(1.234)).toBe(1.23);
    expect(round2(1.235)).toBe(1.24);
    expect(round2(1234.567)).toBe(1234.57);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  it('1.005 实际落成 1.00 —— 二进制浮点存的是 1.00499…，这是现状不是 bug', () => {
    // 金额链路上没有它的位置：入库前一律走 Decimal，round2 只用于展示与比较容差。
    // 钉在这里是为了下次有人看到「1.005 变成 1」时，先看到这行注释再决定改不改。
    expect(round2(1.005)).toBe(1);
  });
});

describe('diffLevel —— 对账差额分级', () => {
  it('系统侧没口径 → NO_BASIS，而不是「差了一整张账单」', () => {
    expect(diffLevel(null, 100000)).toBe('NO_BASIS');
    expect(diffLevel(null, 0)).toBe('NO_BASIS');
  });

  it('一块钱以内算对上（分位舍入的正常抖动）', () => {
    expect(diffLevel(10000, 10000.8)).toBe('MATCH');
    expect(diffLevel(10000, 10000)).toBe('MATCH');
  });

  it('0.5% 以内算对上 —— 大账单差几十块不该被判成差异', () => {
    expect(diffLevel(1_000_000, 1_004_000)).toBe('MATCH');
  });

  it('小账单差一点点仍算对上（绝对值先于比例）', () => {
    // 差 0.9 元，占比 9% 但绝对值 ≤1
    expect(diffLevel(10, 10.9)).toBe('MATCH');
  });

  it('5% 以内是小差异', () => {
    expect(diffLevel(10000, 10300)).toBe('MINOR');
  });

  it('超过 5% 是大差异', () => {
    expect(diffLevel(10000, 12000)).toBe('MAJOR');
  });

  it('账单比系统少也一样分级（差额取绝对值）', () => {
    expect(diffLevel(12000, 10000)).toBe('MAJOR');
    expect(diffLevel(10300, 10000)).toBe('MINOR');
  });

  it('两边都是 0 算对上', () => {
    expect(diffLevel(0, 0)).toBe('MATCH');
  });
});

describe('overlapNights —— 包房周期与账单期次的重叠夜数', () => {
  const d = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

  it('完全重叠 = 闭区间天数（含两端）', () => {
    expect(overlapNights(d('2026-09-01'), d('2026-09-03'), d('2026-09-01'), d('2026-09-03'))).toBe(
      3,
    );
  });

  it('部分重叠只算交集', () => {
    expect(overlapNights(d('2026-09-01'), d('2026-09-30'), d('2026-09-28'), d('2026-10-05'))).toBe(
      3,
    );
  });

  it('完全不重叠 = 0', () => {
    expect(overlapNights(d('2026-09-01'), d('2026-09-10'), d('2026-09-11'), d('2026-09-20'))).toBe(
      0,
    );
  });

  it('只挨着一天也算一夜', () => {
    expect(overlapNights(d('2026-09-01'), d('2026-09-10'), d('2026-09-10'), d('2026-09-20'))).toBe(
      1,
    );
  });

  it('周期两端缺日期（脏数据）返回 0，不参与合计', () => {
    expect(overlapNights(d('2026-09-01'), d('2026-09-10'), null, d('2026-09-05'))).toBe(0);
    expect(overlapNights(d('2026-09-01'), d('2026-09-10'), d('2026-09-05'), null)).toBe(0);
  });
});
