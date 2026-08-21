import { describe, expect, it } from 'vitest';
import { findAirlineBrand } from './airline-brands.js';
import { buildFlightRoutePrompt, type PosterContent } from './marketing.templates.js';

const content: PosterContent = {
  headline: '8月21日起',
  subtitle: '黄金时刻·每天一班',
  slogan: '飞岘港，选越竹，越飞越值！',
  highlights: ['安全出行·严苛保障', '舒适日间·尊享旅程', '高标准飞行保障·贴心服务'],
  ctaLine1: '开启您的岘港尊享之旅',
  ctaLine2: '即刻预订，享黄金时刻优惠',
  baggageText: '20KG+手提7KG',
  outbound: { flightNumber: 'QH9589', route: '澳门 → 岘港', time: '15:45-16:30' },
  inbound: null,
};

describe('buildFlightRoutePrompt', () => {
  it('拼入越竹 logo 描述、整图字段和固定禁令', () => {
    const prompt = buildFlightRoutePrompt('OCEAN_GOLD', content, findAirlineBrand('QH9589'));

    expect(prompt).toContain('【顶部品牌标志】标志左半部分是深蓝色（#073871）');
    expect(prompt).toContain('「BAMBOO」');
    expect(prompt).toContain('【一张居中的白色信息卡】');
    expect(prompt).toContain('航班号 QH9589');
    expect(prompt).toContain('【严格禁止】不得添加任何上述内容之外的信息');
    expect(prompt).toContain('不得自行计算或标注飞行时长');
  });

  it('往返海报使用左右两张信息卡', () => {
    const prompt = buildFlightRoutePrompt('SUNNY_TROPICAL', {
      ...content,
      inbound: { flightNumber: 'QH9590', route: '岘港 → 澳门', time: '17:30-20:15' },
    }, findAirlineBrand('QH9589'));

    expect(prompt).toContain('【两张白色信息卡】左卡');
    expect(prompt).toContain('航班号 QH9590');
    expect(prompt).not.toContain('【一张居中的白色信息卡】');
  });

  it('话术为空时不出现对应整行，未知航司不猜品牌', () => {
    const prompt = buildFlightRoutePrompt('MINIMAL_EDITORIAL', {
      ...content,
      headline: '',
      slogan: '',
      highlights: [],
      ctaLine1: '',
      ctaLine2: '',
      baggageText: null,
      outbound: { ...content.outbound, flightNumber: '9C1234' },
    }, null);

    expect(prompt).not.toContain('【主标题】');
    expect(prompt).not.toContain('【标语】');
    expect(prompt).not.toContain('【三个并排金色圆角卡片】');
    expect(prompt).not.toContain('【底部】');
    expect(prompt).not.toContain('BAMBOO');
    expect(prompt).toContain('通用白色客机');
    expect(prompt).toContain('【严格禁止】');
  });
});
