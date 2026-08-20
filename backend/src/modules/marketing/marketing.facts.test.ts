import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../db/prisma.js';
import { MarketingInputError, buildFlightRouteFacts } from './marketing.facts.js';

vi.mock('../../db/prisma.js', () => ({
  prisma: { flightSchedule: { findUnique: vi.fn() } },
}));

const outbound = {
  id: 'outbound',
  flightId: 'flight-outbound',
  departureTime: new Date('2026-08-21T02:00:00.000Z'),
  arrivalTime: new Date('2026-08-21T04:30:00.000Z'),
  departureTz: 'Asia/Macau',
  arrivalTz: 'Asia/Ho_Chi_Minh',
  flight: { flightNumber: 'QH9589', originCode: 'MFM', destinationCode: 'DAD' },
};

function inbound(overrides: { originCode?: string; destinationCode?: string; departureTime?: Date; id?: string } = {}) {
  return {
    ...outbound,
    id: overrides.id ?? 'inbound',
    flightId: 'flight-inbound',
    departureTime: overrides.departureTime ?? new Date('2026-08-22T02:00:00.000Z'),
    arrivalTime: new Date('2026-08-22T04:30:00.000Z'),
    flight: {
      ...outbound.flight,
      flightNumber: 'QH9590',
      originCode: overrides.originCode ?? 'DAD',
      destinationCode: overrides.destinationCode ?? 'MFM',
    },
  };
}

beforeEach(() => {
  vi.mocked(prisma.flightSchedule.findUnique).mockReset();
});

describe('buildFlightRouteFacts — 回程事实校验', () => {
  it('拒绝同一个班次同时作为去程和回程', async () => {
    await expect(buildFlightRouteFacts({ outboundScheduleId: 'same', returnScheduleId: 'same' }))
      .rejects.toThrow('回程班次不能与去程班次相同');
  });

  it('拒绝起降机场未与去程互换的回程', async () => {
    vi.mocked(prisma.flightSchedule.findUnique)
      .mockResolvedValueOnce(outbound as never)
      .mockResolvedValueOnce(inbound({ originCode: 'DAD', destinationCode: 'HAN' }) as never);

    await expect(buildFlightRouteFacts({ outboundScheduleId: 'outbound', returnScheduleId: 'inbound' }))
      .rejects.toThrow('起降机场必须与去程互换');
  });

  it('拒绝早于或等于去程到达时间的回程', async () => {
    vi.mocked(prisma.flightSchedule.findUnique)
      .mockResolvedValueOnce(outbound as never)
      .mockResolvedValueOnce(inbound({ departureTime: new Date('2026-08-21T04:30:00.000Z') }) as never);

    await expect(buildFlightRouteFacts({ outboundScheduleId: 'outbound', returnScheduleId: 'inbound' }))
      .rejects.toThrow('回程出发时间必须晚于去程到达时间');
  });
});

describe('MarketingInputError', () => {
  it('是可由路由识别的明确输入错误', () => {
    expect(new MarketingInputError('输入错误')).toBeInstanceOf(Error);
  });
});
