/**
 * 航司 no-show 名单匹配内核 · 单测（纯函数，零 IO）
 *
 * 这一层的正确性直接决定「会不会给没 no-show 的客人打标、放掉他的回程座位」，
 * 所以每一条容错都得有对应断言：分隔符、姓名顺序、中英文、同名多人。
 */
import { describe, expect, it } from 'vitest';
import {
  buildNameKeys,
  deriveBatchOrderToken,
  documentTail,
  matchRosterLines,
  normalizeChineseName,
  normalizeDocumentNumber,
  parseRosterLines,
  uuidV5,
  type RosterCandidate,
} from './no-show-roster-match.js';

function pax(over: Partial<RosterCandidate> & { passengerId: string }): RosterCandidate {
  return {
    orderId: `ord-${over.passengerId}`,
    orderNumber: `FTM20260902-${over.passengerId}`,
    fullName: 'ZHANG/SAN',
    chineseName: null,
    documentNumber: 'E10000001',
    ...over,
  };
}

describe('parseRosterLines · 整块名单按行切', () => {
  it('去空行、trim、按原文去重，保序', () => {
    expect(parseRosterLines('  A \n\n B\r\nA\n  \n')).toEqual(['A', 'B']);
  });

  it('截断到上限', () => {
    const text = Array.from({ length: 10 }, (_, i) => `L${i}`).join('\n');
    expect(parseRosterLines(text, 3)).toEqual(['L0', 'L1', 'L2']);
  });

  it('空输入 → 空数组（不抛错）', () => {
    expect(parseRosterLines('')).toEqual([]);
    expect(parseRosterLines('   \n  ')).toEqual([]);
  });
});

describe('归一化小工具', () => {
  it('证件号去非字母数字并大写', () => {
    expect(normalizeDocumentNumber(' e1234-5678 ')).toBe('E12345678');
  });

  it('证件号对外只给后 4 位；过短原样', () => {
    expect(documentTail('E12345678')).toBe('5678');
    expect(documentTail('E12')).toBe('E12');
    expect(documentTail(null)).toBe('');
  });

  it('中文名去掉一切非汉字（空格 / 间隔号 / 括号里的拼音都不参与比对）', () => {
    expect(normalizeChineseName(' 陈 志远 (CHEN/ZHIYUAN) ')).toBe('陈志远');
    expect(normalizeChineseName('阿依古丽·买买提')).toBe('阿依古丽买买提');
  });
});

describe('buildNameKeys · 姓名归一化键', () => {
  it('姓/名 写法生成正反两把键', () => {
    expect(buildNameKeys('ZHANG/SAN')).toEqual(expect.arrayContaining(['ZHANGSAN', 'SANZHANG']));
  });

  it('空格写法与斜杠写法能对上', () => {
    const a = new Set(buildNameKeys('ZHANG/SAN'));
    expect(buildNameKeys('SAN ZHANG').some((k) => a.has(k))).toBe(true);
    expect(buildNameKeys('zhang san').some((k) => a.has(k))).toBe(true);
  });

  it('多词名（姓 + 双字名）反序也能对上', () => {
    const a = new Set(buildNameKeys('CHEN/ZHI YUAN'));
    expect(buildNameKeys('ZHI YUAN CHEN').some((k) => a.has(k))).toBe(true);
  });

  it('已粘在一起的单词姓名等于正序键', () => {
    expect(buildNameKeys('ZHANGSAN')).toEqual(['ZHANGSAN']);
  });

  it('纯数字/空串不产生键（不会拿证件号当名字）', () => {
    expect(buildNameKeys('E12345678')).toEqual([]);
    expect(buildNameKeys('')).toEqual([]);
  });
});

describe('matchRosterLines · 逐行匹配', () => {
  const chen = pax({
    passengerId: 'p-chen',
    fullName: 'CHEN/ZHIYUAN',
    chineseName: '陈志远',
    documentNumber: 'E10000001',
  });
  const lin = pax({
    passengerId: 'p-lin',
    fullName: 'LIN/XIAOMEI',
    chineseName: '林晓梅',
    documentNumber: 'E20000002',
  });
  const pool = [chen, lin];

  it('护照号精确命中（大小写/连字符都容错）', () => {
    const r = matchRosterLines(['e2000-0002'], pool);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].candidate.passengerId).toBe('p-lin');
    expect(r.matched[0].matchedBy).toBe('DOCUMENT');
  });

  it('「姓名 护照号」同行时护照号优先（名字对不上也按证件号认人）', () => {
    const r = matchRosterLines(['SOMEONE ELSE E10000001'], pool);
    expect(r.matched[0].candidate.passengerId).toBe('p-chen');
    expect(r.matched[0].matchedBy).toBe('DOCUMENT');
  });

  it('英文名归一化：「名 姓」顺序也能命中', () => {
    const r = matchRosterLines(['ZHIYUAN CHEN'], pool);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].candidate.passengerId).toBe('p-chen');
    expect(r.matched[0].matchedBy).toBe('NAME');
  });

  it('中文名精确命中', () => {
    const r = matchRosterLines(['林晓梅'], pool);
    expect(r.matched[0].candidate.passengerId).toBe('p-lin');
    expect(r.matched[0].matchedBy).toBe('CHINESE_NAME');
  });

  it('中文名录在 fullName 里的老单也认', () => {
    const legacy = pax({ passengerId: 'p-old', fullName: '王小虎', chineseName: null });
    const r = matchRosterLines(['王小虎'], [legacy]);
    expect(r.matched[0].candidate.passengerId).toBe('p-old');
  });

  it('同名多人 → ambiguous，绝不替人做主', () => {
    const twinA = pax({ passengerId: 'p-a', fullName: 'WANG/WEI', documentNumber: 'E30000003' });
    const twinB = pax({ passengerId: 'p-b', fullName: 'WANG/WEI', documentNumber: 'E40000004' });
    const r = matchRosterLines(['WANG/WEI'], [twinA, twinB]);
    expect(r.matched).toHaveLength(0);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0].candidates.map((c) => c.passengerId).sort()).toEqual(['p-a', 'p-b']);
  });

  it('同名两人里指名护照号 → 不再 ambiguous', () => {
    const twinA = pax({ passengerId: 'p-a', fullName: 'WANG/WEI', documentNumber: 'E30000003' });
    const twinB = pax({ passengerId: 'p-b', fullName: 'WANG/WEI', documentNumber: 'E40000004' });
    const r = matchRosterLines(['WANG/WEI E40000004'], [twinA, twinB]);
    expect(r.ambiguous).toHaveLength(0);
    expect(r.matched[0].candidate.passengerId).toBe('p-b');
  });

  it('一位都对不上 → unmatched（不硬凑）', () => {
    const r = matchRosterLines(['某位不在本班的客人'], pool);
    expect(r.matched).toHaveLength(0);
    expect(r.ambiguous).toHaveLength(0);
    expect(r.unmatched).toEqual(['某位不在本班的客人']);
  });

  it('lastName/firstName 拆开录的单也能按名字命中', () => {
    const split = pax({
      passengerId: 'p-split',
      fullName: '',
      lastName: 'ZHAO',
      firstName: 'MING',
      documentNumber: 'E50000005',
    });
    const r = matchRosterLines(['MING ZHAO'], [split]);
    expect(r.matched[0].candidate.passengerId).toBe('p-split');
  });

  it('同一位乘客被多把键命中只算一次（不会误判成 ambiguous）', () => {
    const one = pax({ passengerId: 'p-one', fullName: 'LI/LEI', chineseName: '李雷' });
    const r = matchRosterLines(['LI/LEI'], [one]);
    expect(r.matched).toHaveLength(1);
    expect(r.ambiguous).toHaveLength(0);
  });
});

describe('deriveBatchOrderToken · 批次内逐单幂等键', () => {
  it('同一批 + 同一单恒等（整批重试才能命中逐单回放）', () => {
    const a = deriveBatchOrderToken('b8f4f0f0-1c2d-4e3f-8a9b-0c1d2e3f4a5b', 'ord-1');
    const b = deriveBatchOrderToken('b8f4f0f0-1c2d-4e3f-8a9b-0c1d2e3f4a5b', 'ord-1');
    expect(a).toBe(b);
  });

  it('换单 / 换批次都得到不同 token', () => {
    const base = deriveBatchOrderToken('b8f4f0f0-1c2d-4e3f-8a9b-0c1d2e3f4a5b', 'ord-1');
    expect(deriveBatchOrderToken('b8f4f0f0-1c2d-4e3f-8a9b-0c1d2e3f4a5b', 'ord-2')).not.toBe(base);
    expect(deriveBatchOrderToken('11111111-2222-4333-8444-555555555555', 'ord-1')).not.toBe(base);
  });

  it('形状是合法 uuid v5（markNoShow 的 uuid 校验必须过）', () => {
    const t = deriveBatchOrderToken('b8f4f0f0-1c2d-4e3f-8a9b-0c1d2e3f4a5b', 'ord-1');
    expect(t).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('与 RFC 4122 的标准向量一致（DNS 命名空间 + "www.example.org"）', () => {
    expect(uuidV5('www.example.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '74738ff5-5367-5958-9aee-98fffdcd1876',
    );
  });
});
