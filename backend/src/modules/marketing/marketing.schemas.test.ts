import { describe, expect, it } from 'vitest';
import { createFlightRoutePosterSchema } from './marketing.schemas.js';

describe('createFlightRoutePosterSchema — 版式 key', () => {
  it('未知 templateKey 直接校验失败', () => {
    const result = createFlightRoutePosterSchema.safeParse({
      title: '航线海报',
      outboundScheduleId: 'schedule-1',
      templateKey: 'UNKNOWN_TEMPLATE',
    });

    expect(result.success).toBe(false);
  });

  it('新海报文案字段使用默认值并限制长度', () => {
    const result = createFlightRoutePosterSchema.parse({
      title: '航线海报',
      outboundScheduleId: 'schedule-1',
      templateKey: 'OCEAN_GOLD',
    });

    expect(result.subtitle).toBe('黄金时刻·每天一班');
    expect(result.highlights).toHaveLength(3);
    expect(result.ctaLine2).toBe('即刻预订，享黄金时刻优惠');
    expect(createFlightRoutePosterSchema.safeParse({
      title: '航线海报',
      outboundScheduleId: 'schedule-1',
      templateKey: 'OCEAN_GOLD',
      headline: '超长标题'.repeat(6),
    }).success).toBe(false);
  });
});
