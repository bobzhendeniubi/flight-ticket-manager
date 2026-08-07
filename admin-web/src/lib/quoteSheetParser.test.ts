/**
 * 报价表粘贴解析回归。
 *
 * 样本按运营报价表的真实版式复刻（套票 sheet 每天一块「表头 + 晚数 × 去回两行」，
 * OTA sheet 左右两张并排表），价格为示例数字。
 * 覆盖：公告行 / 表头行 / 回程行、「/」空档、售罄与「余位」备注、Excel 序列号日期、
 * M/D 补年（含跨年）、同格重复取最后一次、只复制半张表。
 */
import { describe, it, expect } from 'vitest';
import { parseGroundQuoteSheet, parseOtaQuoteSheet, parseQuoteDate } from './quoteSheetParser';

/** 一行：单元格用制表符连接（Excel 复制出来就是这个形状）。 */
const row = (...cells: string[]): string => cells.join('\t');
const sheet = (...lines: string[]): string => lines.join('\n');

const GROUND_HEADER = row(
  '日期',
  '晚数',
  '星期',
  '时刻',
  '航段',
  '市区三星',
  '市区四星',
  '市区五星',
  '国际五星',
  '备注',
  '升级',
);

/** 套票 sheet 一天一块：公告行 + 表头 + 若干组晚数 ×（去程行 + 回程行）。 */
const GROUND_SAMPLE = sheet(
  '更新于08月07日11:40',
  '1、温馨提示：以上价格含机票+酒店，不含个人消费',
  '=DISPIMG("ID_9A0B",1)',
  '',
  GROUND_HEADER,
  row('2026-08-07', '1晚', '星期五', '16:40-17:35', 'QH9589澳门-岘港', '1368', '1418', '/', '/', '少量', '加1400'),
  row('2026-08-08', '', '星期六', '12:30-15:10', 'QH9588岘港-澳门', '', '', '', '', '', ''),
  row('2026-08-07', '2晚', '星期五', '16:40-17:35', 'QH9589澳门-岘港', '1858', '1898', '/', '/', '少量', '加1400'),
  row('2026-08-09', '', '星期日', '12:30-15:10', 'QH9588岘港-澳门', '', '', '', '', '', ''),
  row('2026-08-07', '3晚', '星期五', '16:40-17:35', 'QH9589澳门-岘港', '2288', '2358', '2988', '3688', '', '加1400'),
  row('2026-08-10', '', '星期一', '12:30-15:10', 'QH9588岘港-澳门', '', '', '', '', '', ''),
);

describe('parseGroundQuoteSheet 套票报价表', () => {
  it('只认去程行：公告行 / 表头行 / 回程行 / 空行都不产生条目也不进跳过清单', () => {
    const { entries, skipped } = parseGroundQuoteSheet(GROUND_SAMPLE, '2026-08');

    expect(skipped).toEqual([]);
    // 3 个去程行：1晚/2晚 各命中 2 档（后两档是「/」），3晚 命中 4 档 → 8 条
    expect(entries).toHaveLength(8);
  });

  it('四档价格按固定列序落到档次，「/」与空列跳过不写', () => {
    const { entries } = parseGroundQuoteSheet(GROUND_SAMPLE, '2026-08');

    expect(entries.filter((e) => e.nights === 1)).toEqual([
      { departDate: '2026-08-07', nights: 1, tier: 'CITY_3STAR', pricePerPersonCny: 1368 },
      { departDate: '2026-08-07', nights: 1, tier: 'CITY_4STAR', pricePerPersonCny: 1418 },
    ]);
    expect(entries.filter((e) => e.nights === 3)).toEqual([
      { departDate: '2026-08-07', nights: 3, tier: 'CITY_3STAR', pricePerPersonCny: 2288 },
      { departDate: '2026-08-07', nights: 3, tier: 'CITY_4STAR', pricePerPersonCny: 2358 },
      { departDate: '2026-08-07', nights: 3, tier: 'CITY_5STAR', pricePerPersonCny: 2988 },
      { departDate: '2026-08-07', nights: 3, tier: 'INTL_5STAR', pricePerPersonCny: 3688 },
    ]);
  });

  it('去程行的日期取自出发日列，回程行不会覆盖出发日', () => {
    const { entries } = parseGroundQuoteSheet(GROUND_SAMPLE, '2026-08');

    expect(entries.every((e) => e.departDate === '2026-08-07')).toBe(true);
  });

  it('四档全是「/」的去程行列入跳过清单（带行号与原因）', () => {
    const text = sheet(
      GROUND_HEADER,
      row('2026-08-07', '1晚', '星期五', '16:40-17:35', 'QH9589澳门-岘港', '/', '/', '/', '/', '售罄', ''),
    );

    const { entries, skipped } = parseGroundQuoteSheet(text, '2026-08');

    expect(entries).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].line).toBe(2);
    expect(skipped[0].reason).toContain('四档价格都不是数字');
  });

  it('晚数超出 1–5 晚的行进跳过清单', () => {
    const text = row('2026-08-07', '7晚', '星期五', '16:40-17:35', 'QH9589澳门-岘港', '3888', '', '', '');

    const { entries, skipped } = parseGroundQuoteSheet(text, '2026-08');

    expect(entries).toEqual([]);
    expect(skipped[0].reason).toContain('超出可维护范围');
  });

  it('M/D 日期按所选月份的年份补全，月份靠前视为跨年往后推', () => {
    const text = sheet(
      row('8/12', '1晚', '星期三', '16:40-17:35', 'QH9589澳门-岘港', '1368', '', '', ''),
      row('1/5', '1晚', '星期一', '16:40-17:35', 'QH9589澳门-岘港', '1568', '', '', ''),
    );

    const { entries } = parseGroundQuoteSheet(text, '2026-08');

    expect(entries.map((e) => e.departDate)).toEqual(['2026-08-12', '2027-01-05']);
  });

  it('同一（出发日 × 晚数 × 档次）重复出现时取最后一次', () => {
    const text = sheet(
      row('2026-08-07', '1晚', '星期五', '16:40-17:35', 'QH9589澳门-岘港', '1368', '', '', ''),
      row('2026-08-07', '1晚', '星期五', '16:40-17:35', 'QH9589澳门-岘港', '1288', '', '', ''),
    );

    const { entries } = parseGroundQuoteSheet(text, '2026-08');

    expect(entries).toEqual([
      { departDate: '2026-08-07', nights: 1, tier: 'CITY_3STAR', pricePerPersonCny: 1288 },
    ]);
  });

  it('价格带 ¥ 与千分位逗号照样识别', () => {
    const text = row('2026-08-07', '1晚', '星期五', '16:40-17:35', 'QH9589澳门-岘港', '¥1,368', '', '', '');

    const { entries } = parseGroundQuoteSheet(text, '2026-08');

    expect(entries[0].pricePerPersonCny).toBe(1368);
  });

  it('空文本安全返回空结果', () => {
    expect(parseGroundQuoteSheet('', '2026-08')).toEqual({ entries: [], skipped: [] });
  });
});

const OTA_HEADER = row(
  '日期',
  '星期',
  '航段',
  '航班号',
  'OTA结算',
  '易达 OTA结算',
  '日期',
  '星期',
  '航段',
  '航班号',
  'OTA结算',
  '易达 OTA结算',
);

/** OTA sheet：左右两张并排表，右表日期可能是 Excel 序列号。 */
const OTA_SAMPLE = sheet(
  OTA_HEADER,
  row('2026-08-08', '星期六', '澳门-岘港', 'QH9589', '900', '900', '2026-08-08', '星期六', '岘港澳门', 'QH9588', '售罄', '955余1'),
  row('2026-08-09', '星期日', '澳门-岘港', 'QH9589', '790', '790', '46243', '星期日', '岘港澳门', 'QH9588', '880', '880'),
  row('2026-08-10', '星期一', '澳门-岘港', 'QH9589', '765余7', '820', '2026-08-10', '星期一', '岘港澳门', 'QH9588', '1200结算余1', '1200'),
);

describe('parseOtaQuoteSheet 机票报价表', () => {
  it('左右两张并排表各出一条，权威价取「OTA结算」列而非「易达」列', () => {
    const { entries } = parseOtaQuoteSheet(OTA_SAMPLE, '2026-08');

    expect(entries).toEqual([
      { departDate: '2026-08-08', flightNumber: 'QH9589', pricePerPersonCny: 900 },
      { departDate: '2026-08-09', flightNumber: 'QH9588', pricePerPersonCny: 880 },
      { departDate: '2026-08-09', flightNumber: 'QH9589', pricePerPersonCny: 790 },
    ]);
  });

  it('右表 Excel 序列号日期按 1900 日期系统折算', () => {
    const { entries } = parseOtaQuoteSheet(OTA_SAMPLE, '2026-08');

    // 46243 → 2026-08-09，与同行左表日期一致
    expect(entries.find((e) => e.flightNumber === 'QH9588')?.departDate).toBe('2026-08-09');
  });

  it('「售罄」「余位」等非纯数字进跳过明细，注明行号 / 左右表 / 原因', () => {
    const { skipped } = parseOtaQuoteSheet(OTA_SAMPLE, '2026-08');

    expect(skipped).toHaveLength(3);
    expect(skipped[0]).toMatchObject({ line: 2 });
    expect(skipped[0].reason).toContain('右表');
    expect(skipped[0].reason).toContain('售罄');
    expect(skipped[1].reason).toContain('左表');
    expect(skipped[1].reason).toContain('765余7');
    expect(skipped[2].reason).toContain('1200结算余1');
  });

  it('表头行与公告行既不出条目也不进跳过明细', () => {
    const text = sheet(OTA_HEADER, '更新于08月07日11:40', '', row('岘港线', '', '', '', '', ''));

    expect(parseOtaQuoteSheet(text, '2026-08')).toEqual({ entries: [], skipped: [] });
  });

  it('只复制半张表（6 列）时按单表解析', () => {
    const text = sheet(
      row('日期', '星期', '航段', '航班号', 'OTA结算', '易达 OTA结算'),
      row('2026-08-08', '星期六', '澳门-岘港', 'QH9589', '900', '900'),
      row('2026-08-09', '星期日', '澳门-岘港', 'QH9589', '790', '790'),
    );

    const { entries, skipped } = parseOtaQuoteSheet(text, '2026-08');

    expect(skipped).toEqual([]);
    expect(entries).toEqual([
      { departDate: '2026-08-08', flightNumber: 'QH9589', pricePerPersonCny: 900 },
      { departDate: '2026-08-09', flightNumber: 'QH9589', pricePerPersonCny: 790 },
    ]);
  });

  it('同一（出发日 × 航班号）重复出现时取最后一次', () => {
    const text = sheet(
      row('2026-08-08', '星期六', '澳门-岘港', 'QH9589', '900', '900'),
      row('2026-08-08', '星期六', '澳门-岘港', 'QH9589', '860', '860'),
    );

    const { entries } = parseOtaQuoteSheet(text, '2026-08');

    expect(entries).toEqual([
      { departDate: '2026-08-08', flightNumber: 'QH9589', pricePerPersonCny: 860 },
    ]);
  });

  it('左右两张表长度不齐时，只有右表有内容的行照样出条目', () => {
    const text = row('', '', '', '', '', '', '2026-08-20', '星期四', '岘港澳门', 'QH9588', '930', '930');

    const { entries, skipped } = parseOtaQuoteSheet(text, '2026-08');

    expect(skipped).toEqual([]);
    expect(entries).toEqual([
      { departDate: '2026-08-20', flightNumber: 'QH9588', pricePerPersonCny: 930 },
    ]);
  });

  it('日期认不出但有航班号的行不静默丢弃', () => {
    const text = row('待定', '星期六', '澳门-岘港', 'QH9589', '900', '900');

    const { entries, skipped } = parseOtaQuoteSheet(text, '2026-08');

    expect(entries).toEqual([]);
    expect(skipped[0].reason).toContain('认不出来');
  });
});

describe('parseQuoteDate 日期兼容', () => {
  it('完整日期三种分隔符都认', () => {
    expect(parseQuoteDate('2026-08-07', '2026-08')).toBe('2026-08-07');
    expect(parseQuoteDate('2026/8/7', '2026-08')).toBe('2026-08-07');
    expect(parseQuoteDate('2026年8月7日', '2026-08')).toBe('2026-08-07');
  });

  it('M/D 按基准年月补全，跨年往后推一年', () => {
    expect(parseQuoteDate('8/7', '2026-08')).toBe('2026-08-07');
    expect(parseQuoteDate('9/1', '2026-08')).toBe('2026-09-01');
    expect(parseQuoteDate('1/5', '2026-12')).toBe('2027-01-05');
  });

  it('Excel 序列号折算；超出合理区间的纯数字不当日期', () => {
    expect(parseQuoteDate('46243', '2026-08')).toBe('2026-08-09');
    expect(parseQuoteDate('808', '2026-08')).toBeNull();
  });

  it('非法日期与空值返回 null', () => {
    expect(parseQuoteDate('2026-02-30', '2026-08')).toBeNull();
    expect(parseQuoteDate('', '2026-08')).toBeNull();
    expect(parseQuoteDate('售罄', '2026-08')).toBeNull();
  });
});
