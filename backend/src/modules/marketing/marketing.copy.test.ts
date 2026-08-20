import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PosterFact } from './marketing.facts.js';
import {
  extractFlightCandidates,
  extractTimeCandidates,
  generatePosterCopy,
  sanitizePosterCopy,
} from './marketing.copy.js';

const facts: PosterFact[] = [
  { key: 'outbound.flightNumber', label: '去程航班号', value: 'QH9589', strict: true, group: 'outbound' },
  { key: 'outbound.time', label: '去程时刻', value: '15:45-16:30', strict: true, group: 'outbound' },
  { key: 'outbound.route', label: '去程航线', value: '澳门 → 岘港', strict: true, group: 'outbound' },
  { key: 'effectiveFrom', label: '生效日期', value: '8月21日起', strict: true, group: 'global' },
  { key: 'baggage', label: '行李额', value: '20KG+手提7KG', strict: false, group: 'global' },
];

describe('sanitizePosterCopy — 占位符模板', () => {
  it('用事实快照确定性替换占位符', () => {
    const result = sanitizePosterCopy(
      {
        moments: '{{outboundFlight}} {{outboundTime}}，{{route}}出发，{{effectiveFrom}}见。',
        agent: '行李额：{{baggage}}，欢迎咨询。',
        xhs: '海岛路线：{{outboundRoute}}，欢迎私信。',
      },
      facts,
    );

    expect(result.rejected).toEqual([]);
    expect(result.copy.moments).toBe('QH9589 15:45-16:30，澳门 → 岘港出发，8月21日起见。');
    expect(result.copy.agent).toBe('行李额：20KG+手提7KG，欢迎咨询。');
    expect(result.copy.xhs).toBe('海岛路线：澳门 → 岘港，欢迎私信。');
  });

  it('模型自行写出具体航班号和时刻时，该段被判不可信', () => {
    const result = sanitizePosterCopy(
      {
        moments: 'QH 9999 19:00，欢迎咨询。',
        agent: '{{outboundFlight}} {{outboundTime}}，可安排预订。',
        xhs: '海岛出发：{{route}}。',
      },
      facts,
    );

    expect(result.copy.moments).toBeNull();
    expect(result.rejected.find((item) => item.kind === 'moments')?.reason).toContain('具体航班号');
    expect(result.rejected.find((item) => item.kind === 'moments')?.reason).toContain('具体时刻');
    expect(result.copy.agent).toContain('QH9589');
  });

  it('即使模型写的是正确硬数据，也必须使用占位符', () => {
    const result = sanitizePosterCopy(
      { moments: 'QH9589 15:45-16:30，澳门 → 岘港。' },
      facts,
    );

    expect(result.copy.moments).toBeNull();
    expect(result.rejected.find((item) => item.kind === 'moments')?.reason).toContain('模板未包含事实占位符');
  });

  it.each([
    '3U8633 {{route}}',
    '9C1234 {{route}}',
    '8:05 {{route}}',
    '8点05分 {{route}}',
    '8時05分 {{route}}',
    '３Ｕ８６３３ {{route}}',
    '８：０５ {{route}}',
  ])('拦截未被事实白名单允许的硬数据：%s', (value) => {
    const result = sanitizePosterCopy({ moments: value }, facts);
    expect(result.copy.moments).toBeNull();
    expect(result.rejected[0]?.reason).toMatch(/具体航班号|具体时刻/u);
  });

  it('允许规范化后属于事实快照的航班号和时刻', () => {
    const result = sanitizePosterCopy(
      { moments: '航班 {{outboundFlight}}，也可写 １５：４５，路线 {{route}}。', agent: '', xhs: '' },
      facts,
    );
    expect(result.copy.moments).toContain('QH9589');
    expect(result.rejected.find((item) => item.kind === 'moments')).toBeUndefined();
  });

  it('替换后发现未闭合的未知占位符时拒绝该段', () => {
    const result = sanitizePosterCopy(
      { moments: '{{route}}，{{unknown', agent: '', xhs: '' },
      facts,
    );
    expect(result.copy.moments).toBeNull();
    expect(result.rejected.find((item) => item.kind === 'moments')?.reason).toContain('未解析占位符');
  });

  it('保留首轮通过的段落，只重试被拒绝的段落', async () => {
    const response = (body: unknown): Response => ({ ok: true, json: async () => body } as Response);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        choices: [{ message: { content: JSON.stringify({
          moments: '{{route}} 首轮通过',
          agent: '9C1234 {{route}}',
          xhs: '{{outboundFlight}} 首轮通过',
        }) } }],
      }))
      .mockResolvedValueOnce(response({
        choices: [{ message: { content: JSON.stringify({ agent: '{{outboundFlight}} 重试通过' }) } }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generatePosterCopy(
      { apiKey: 'key', compatibleBaseUrl: 'https://example.test', nativeBaseUrl: 'https://example.test', vlModel: 'model' },
      {
        outbound: { flightNumber: 'QH9589', originCode: 'MFM', destinationCode: 'DAD', originName: '澳门', destinationName: '岘港', departTime: '15:45', arriveTime: '16:30' },
        inbound: null,
        effectiveFrom: null,
        baggageText: null,
      },
      facts,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result?.copy.moments).toBe('澳门 → 岘港 首轮通过');
    expect(result?.copy.agent).toBe('QH9589 重试通过');
    expect(result?.copy.xhs).toBe('QH9589 首轮通过');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('硬数据抽取', () => {
  it('覆盖数字开头航司码、单位数小时和全角字符', () => {
    expect(extractFlightCandidates('3U8633 9C1234 ３Ｕ８６３３')).toEqual(['3U8633', '9C1234', '3U8633']);
    expect(extractTimeCandidates('8:05 8点05分 8時05分 ８：０５')).toEqual(['08:05', '08:05', '08:05', '08:05']);
  });
});
