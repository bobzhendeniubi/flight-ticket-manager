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
});
