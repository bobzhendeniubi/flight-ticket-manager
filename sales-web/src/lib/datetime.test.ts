/**
 * businessYmd / businessToday 单测。
 *
 * 覆盖两条线：
 *  1. 北京口径的日期折算本身要对（含跨零点边界）。
 *  2. 回归：0924 实测 `/products/bundles/:id/sellable-dates` 与 `/flights/search` 两个
 *     接口都吃过「用 Intl.DateTimeFormat('en-CA', {...}).format(d) 骗出 YYYY-MM-DD」这个
 *     常见写法的亏——个别精简 ICU 的浏览器 / 内嵌 WebView 遇到未加载的 locale 不会抛异常，
 *     而是静默退回设备自身 locale，英文 locale 设备上吐出 MM/DD/YYYY 直接拼进 query 会 400。
 *     修复后 businessYmd 改用纯数值运算，不再经过任何 Intl 字符串格式化；用一个「即使
 *     Intl.DateTimeFormat 被劫持成吐出乱码格式，结果依然正确」的测试把这条回归钉住——
 *     以后谁不小心把实现换回 Intl.format() 那一套，这个测试会先炸。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { businessYmd, businessToday, addDaysYmd } from './datetime';

describe('businessYmd', () => {
  it('把 UTC 时间戳折算成北京时间的 YYYY-MM-DD（跨零点边界）', () => {
    // UTC 16:30 + 8h = 北京次日 00:30 —— 应算作北京口径的 25 号
    expect(businessYmd('2026-09-24T16:30:00.000Z')).toBe('2026-09-25');
    // UTC 15:59 + 8h = 北京 23:59 —— 仍是 24 号
    expect(businessYmd('2026-09-24T15:59:00.000Z')).toBe('2026-09-24');
  });

  it('输出恒为定长 YYYY-MM-DD（月/日补零）', () => {
    expect(businessYmd('2026-01-05T04:00:00.000Z')).toBe('2026-01-05');
  });

  it('值缺失 / 非法日期时返回 fallback（默认空串）', () => {
    expect(businessYmd(null)).toBe('');
    expect(businessYmd(undefined)).toBe('');
    expect(businessYmd('not-a-date', 'N/A')).toBe('N/A');
  });

  describe('不依赖 Intl.DateTimeFormat 的字符串格式化（回归用例）', () => {
    const OriginalDateTimeFormat = Intl.DateTimeFormat;

    afterEach(() => {
      Intl.DateTimeFormat = OriginalDateTimeFormat;
    });

    it('即使 Intl.DateTimeFormat 被劫持成吐出美式 MM/DD/YYYY，输出依然是正确的 YYYY-MM-DD', () => {
      // 模拟精简 ICU 环境静默退回宿主 locale：不管传什么 locale/options 进来，
      // 一律吐出 en-US 风格的 MM/DD/YYYY——这正是 0924 实测两个接口 400 的真实现象。
      class HijackedDateTimeFormat {
        format(): string {
          return '09/24/2026';
        }
      }
      // @ts-expect-error 测试用简化替身，不需要满足 Intl.DateTimeFormat 完整类型
      Intl.DateTimeFormat = HijackedDateTimeFormat;

      expect(businessYmd('2026-09-24T10:00:00.000Z')).toBe('2026-09-24');
    });
  });
});

describe('businessToday', () => {
  it('返回定长 YYYY-MM-DD', () => {
    expect(businessToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('偏移天数与 addDaysYmd 对同一起点的结果一致', () => {
    const today = businessToday();
    expect(businessToday(7)).toBe(addDaysYmd(today, 7));
    expect(businessToday(-3)).toBe(addDaysYmd(today, -3));
  });
});
