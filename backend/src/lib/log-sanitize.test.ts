/**
 * log-sanitize · 写日志前的截断 / 脱敏（合成数据，无任何真实证件号 / 令牌）。
 */
import { describe, it, expect } from 'vitest';
import {
  firstNonEmptyLine,
  maskPersonalIdentifiers,
  sanitizeLogText,
  scrubSecrets,
  stripQueryAndHash,
  truncateText,
} from './log-sanitize.js';

describe('truncateText', () => {
  it('不超长原样返回', () => {
    expect(truncateText('abc', 3)).toBe('abc');
  });

  it('超长截到 max 个字符（含省略号）', () => {
    const out = truncateText('一二三四五六', 4);
    expect(out).toBe('一二三…');
    expect(out.length).toBe(4);
  });
});

describe('stripQueryAndHash', () => {
  it('去掉 query 与 hash', () => {
    expect(stripQueryAndHash('/orders?search=张三&page=2')).toBe('/orders');
    expect(stripQueryAndHash('/orders#top')).toBe('/orders');
    expect(stripQueryAndHash('/orders/abc')).toBe('/orders/abc');
  });
});

describe('firstNonEmptyLine', () => {
  it('多行消息只取首个非空行', () => {
    expect(firstNonEmptyLine('\n\nInvalid `prisma.order.create()` invocation\n{ data: {...} }')).toBe(
      'Invalid `prisma.order.create()` invocation',
    );
  });
});

describe('scrubSecrets', () => {
  it('抹掉 Bearer 令牌与 JWT 形态', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl';
    expect(scrubSecrets(`Authorization: Bearer abc.def-ghi`)).toBe('Authorization: Bearer [redacted]');
    expect(scrubSecrets(`token ${jwt} leaked`)).toBe('token [jwt] leaked');
  });

  it('URL 保留路径，去掉带参数的 query / hash', () => {
    expect(scrubSecrets('GET https://api.example.test/orders?search=张三&page=2 failed')).toBe(
      'GET https://api.example.test/orders failed',
    );
    expect(scrubSecrets('redirect /login#access_token=xyz')).toBe('redirect /login');
  });

  it('不带 = 的问号不动（避免误伤正文里的问号）', () => {
    expect(scrubSecrets("Unexpected token '?'")).toBe("Unexpected token '?'");
  });

  it('调用栈里带 query 的脚本地址：去掉参数、保留行列号', () => {
    expect(scrubSecrets('    at f (https://admin.example.test/assets/a.js?v=1:10:20)')).toBe(
      '    at f (https://admin.example.test/assets/a.js:10:20)',
    );
    expect(scrubSecrets('    at http://localhost:5174/src/App.tsx?t=1695000000:12:5')).toBe(
      '    at http://localhost:5174/src/App.tsx:12:5',
    );
  });
});

describe('maskPersonalIdentifiers', () => {
  it('护照号 / 通行证号只留首位与尾 4 位', () => {
    expect(maskPersonalIdentifiers('证件号E12345678已在订单中')).toBe('证件号E****5678已在订单中');
    expect(maskPersonalIdentifiers('EA1234567')).toBe('E****4567');
  });

  it('身份证号与手机号同样遮住', () => {
    expect(maskPersonalIdentifiers('身份证 11010519491231002X')).toBe('身份证 1*************002X');
    expect(maskPersonalIdentifiers('手机 13812345678')).toBe('手机 1******5678');
  });

  it('订单号、航班号、日期、Prisma 错误码不误伤', () => {
    const text = '订单 FTM2026090561200 航班 VJ5282 日期 2026-09-25 20260925 错误 P2002';
    expect(maskPersonalIdentifiers(text)).toBe(text);
  });
});

describe('sanitizeLogText', () => {
  it('先遮证件号再截断，截断后不会漏出半个证件号', () => {
    const out = sanitizeLogText('重复证件号：E12345678、G87654321', 16);
    expect(out).not.toMatch(/\d{5,}/);
    expect(out.length).toBeLessThanOrEqual(16);
  });
});

// /client-errors 是匿名接口，message / stack 由外部任意构造：脱敏正则必须线性，不能被病态输入拖慢事件循环。
describe('scrubSecrets · 病态输入不拖慢（正则线性）', () => {
  it.each(['?', '#', '?a', '#a'])('64KB 的「%s」重复串在 200ms 内处理完', (unit) => {
    const text = unit.repeat(Math.ceil(65536 / unit.length));
    const started = performance.now();
    sanitizeLogText(text, 4000);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('一段文本里连着多个 ? 参数段，都被去掉', () => {
    expect(scrubSecrets('GET /a?x=1?y=2 done')).toBe('GET /a done');
  });
});
