/**
 * 电子行程单 PDF · 单元测试（vitest）
 *
 * 覆盖：
 *  - determineItineraryTier：全员有票号才算已出票，否则降级确认单档
 *  - getItineraryTitle：两档标题文案（不能把未出票的单印成 E-Ticket）
 *  - ticketCellText：确认单档 PNR/票号一律占位，不印真实值
 *  - computeEffectivePayable：应付 = total + adjustmentCny，与订单「应收」同口径
 *  - renderItineraryPdf：两档都能正常出 Buffer（冒烟），且渲染结果确实分叉
 */
import { describe, it, expect } from 'vitest';
import {
  determineItineraryTier,
  getItineraryTitle,
  ticketCellText,
  computeEffectivePayable,
  renderItineraryPdf,
  type ItineraryData,
} from './itinerary-pdf.js';

const baseFlight = {
  flightNumber: 'MF801',
  origin: 'HAK',
  destination: 'PEK',
  departureTime: new Date('2026-09-01T02:00:00Z'),
  arrivalTime: new Date('2026-09-01T05:00:00Z'),
  departureTz: 'Asia/Shanghai',
  arrivalTz: 'Asia/Shanghai',
  cabin: 'ECONOMY',
};

function baseData(overrides: Partial<ItineraryData> = {}): ItineraryData {
  return {
    orderNumber: 'FT20260901001',
    contactName: '张三',
    contactPhone: '13800000000',
    contactEmail: 'zhangsan@example.com',
    total: '1000.00',
    currency: 'CNY',
    createdAt: new Date('2026-08-20T10:00:00Z'),
    flights: [baseFlight],
    passengers: [
      { fullName: '张三', passportNumber: 'E12345678', pnr: 'ABCDEF', eticketNumber: '999-1234567890' },
    ],
    ...overrides,
  };
}

describe('determineItineraryTier', () => {
  it('全员都有 e-ticket 号 → ticketed', () => {
    const passengers = [
      { fullName: 'A', passportNumber: 'P1', pnr: 'ABCDEF', eticketNumber: '999-1' },
      { fullName: 'B', passportNumber: 'P2', pnr: 'ABCDEF', eticketNumber: '999-2' },
    ];
    expect(determineItineraryTier(passengers)).toBe('ticketed');
  });

  it('有一人缺 e-ticket 号 → confirmation（不能半出票就印电子客票）', () => {
    const passengers = [
      { fullName: 'A', passportNumber: 'P1', pnr: 'ABCDEF', eticketNumber: '999-1' },
      { fullName: 'B', passportNumber: 'P2', pnr: 'ABCDEF', eticketNumber: null },
    ];
    expect(determineItineraryTier(passengers)).toBe('confirmation');
  });

  it('PNR 有值但 eticketNumber 全空（PAID/PROCESSING 典型场景） → confirmation', () => {
    const passengers = [
      { fullName: 'A', passportNumber: 'P1', pnr: 'ABCDEF', eticketNumber: null },
    ];
    expect(determineItineraryTier(passengers)).toBe('confirmation');
  });

  it('没有乘客（边界情形） → confirmation', () => {
    expect(determineItineraryTier([])).toBe('confirmation');
  });
});

describe('getItineraryTitle', () => {
  it('ticketed 档保留电子客票标题', () => {
    expect(getItineraryTitle('ticketed')).toBe('Electronic Itinerary & E-Ticket');
  });

  it('confirmation 档改为行程确认单标题，不含 E-Ticket 字样', () => {
    const title = getItineraryTitle('confirmation');
    expect(title).toContain('Itinerary Confirmation');
    expect(title).toContain('行程确认单');
    expect(title).not.toContain('E-Ticket');
  });
});

describe('ticketCellText', () => {
  it('ticketed 档打印真实 PNR/票号', () => {
    expect(ticketCellText('ABCDEF', 'ticketed')).toBe('ABCDEF');
  });

  it('ticketed 档缺值时打印 —', () => {
    expect(ticketCellText(null, 'ticketed')).toBe('—');
  });

  it('confirmation 档一律占位，即便底层已有临时 PNR 也不印真实值', () => {
    expect(ticketCellText('TEMP123', 'confirmation')).not.toBe('TEMP123');
    expect(ticketCellText('TEMP123', 'confirmation')).toContain('出票后更新');
  });
});

describe('computeEffectivePayable', () => {
  it('无售后调整时等于 total', () => {
    expect(computeEffectivePayable('1000.00')).toBe('1000.00');
    expect(computeEffectivePayable('1000.00', 0)).toBe('1000.00');
  });

  it('叠加改期费/换人费（adjustmentCny）', () => {
    expect(computeEffectivePayable('1000.00', 150)).toBe('1150.00');
  });

  it('未传 adjustmentCny（旧调用点）按 0 处理', () => {
    expect(computeEffectivePayable('688.50')).toBe('688.50');
  });

  it('保留两位小数四舍五入', () => {
    expect(computeEffectivePayable('99.995', 0)).toBe('100.00');
  });
});

describe('renderItineraryPdf', () => {
  it('已出票档：正常出 PDF buffer，金额含 adjustmentCny', async () => {
    const data = baseData({ adjustmentCny: 200 });
    const pdf = await renderItineraryPdf(data);
    expect(pdf).toBeInstanceOf(Buffer);
    expect(pdf.length).toBeGreaterThan(0);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('确认单档（无票号）：不抛错，正常出 buffer', async () => {
    const data = baseData({
      passengers: [
        { fullName: '张三', passportNumber: 'E12345678', pnr: null, eticketNumber: null },
      ],
    });
    const pdf = await renderItineraryPdf(data);
    expect(pdf).toBeInstanceOf(Buffer);
    expect(pdf.length).toBeGreaterThan(0);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('两档对同一订单渲染结果不同（版式确实分叉，不是永远走同一条路径）', async () => {
    const ticketed = await renderItineraryPdf(baseData());
    const confirmation = await renderItineraryPdf(
      baseData({
        passengers: [
          { fullName: '张三', passportNumber: 'E12345678', pnr: null, eticketNumber: null },
        ],
      }),
    );
    expect(ticketed.equals(confirmation)).toBe(false);
  });
});
