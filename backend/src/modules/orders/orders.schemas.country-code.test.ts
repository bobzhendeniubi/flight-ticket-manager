// 0720 反馈：批量创单粘贴 OTA 名单能解析出乘客，但保存报「Request validation failed」——
// 根因是 nationality / passportIssueCountry 原来是 z.string().length(2)，OTA 名单里常见的
// 3 位护照 MRZ 码（CHN/VNM/USA…）整批被拒。这里验证 schema 层的归一 + 报错文案。
import { describe, expect, it } from 'vitest';
import {
  correctPassengerBodySchema,
  passengerInputSchema,
  selfUpdatePassengerBodySchema,
  swapPassengerBodySchema,
} from './orders.schemas.js';

const BASE_PASSENGER = {
  fullName: 'WU/FEILAI',
  documentNumber: 'EB9452866',
  dateOfBirth: '1990-01-01',
};

describe('passengerInputSchema · nationality 国家码归一', () => {
  it('2 位码直通（大小写不敏感，归一为大写）', () => {
    expect(passengerInputSchema.parse({ ...BASE_PASSENGER, nationality: 'cn' }).nationality).toBe(
      'CN',
    );
    expect(passengerInputSchema.parse({ ...BASE_PASSENGER, nationality: 'US' }).nationality).toBe(
      'US',
    );
  });

  it('常见 3 位码归一为 2 位（CHN→CN / VNM→VN / USA→US）', () => {
    expect(passengerInputSchema.parse({ ...BASE_PASSENGER, nationality: 'CHN' }).nationality).toBe(
      'CN',
    );
    expect(passengerInputSchema.parse({ ...BASE_PASSENGER, nationality: 'VNM' }).nationality).toBe(
      'VN',
    );
    expect(passengerInputSchema.parse({ ...BASE_PASSENGER, nationality: 'usa' }).nationality).toBe(
      'US',
    );
  });

  it('未传时缺省 CN（原有行为不变）', () => {
    expect(passengerInputSchema.parse({ ...BASE_PASSENGER }).nationality).toBe('CN');
  });

  it('查不到映射的 3 位码 → 抛出可读中文错误，指明字段与值（不是笼统的 Request validation failed）', () => {
    expect(() =>
      passengerInputSchema.parse({ ...BASE_PASSENGER, nationality: 'ZZZ' }),
    ).toThrow(/国籍.*ZZZ.*未识别的 3 位国家/);
  });

  it('非法格式（既非 2 位也非 3 位字母）→ 抛出可读中文错误', () => {
    expect(() =>
      passengerInputSchema.parse({ ...BASE_PASSENGER, nationality: 'C1' }),
    ).toThrow(/国籍.*C1.*不是合法的国家码/);
  });
});

describe('passengerInputSchema · passportIssueCountry 国家码归一', () => {
  it('2 位码直通', () => {
    expect(
      passengerInputSchema.parse({ ...BASE_PASSENGER, passportIssueCountry: 'CN' })
        .passportIssueCountry,
    ).toBe('CN');
  });

  it('3 位码归一（MAC→MO / HKG→HK / TWN→TW）', () => {
    expect(
      passengerInputSchema.parse({ ...BASE_PASSENGER, passportIssueCountry: 'MAC' })
        .passportIssueCountry,
    ).toBe('MO');
    expect(
      passengerInputSchema.parse({ ...BASE_PASSENGER, passportIssueCountry: 'HKG' })
        .passportIssueCountry,
    ).toBe('HK');
    expect(
      passengerInputSchema.parse({ ...BASE_PASSENGER, passportIssueCountry: 'TWN' })
        .passportIssueCountry,
    ).toBe('TW');
  });

  it('未传时保持 undefined（可选字段，不受影响）', () => {
    expect(passengerInputSchema.parse({ ...BASE_PASSENGER }).passportIssueCountry).toBeUndefined();
  });

  it('查不到映射的 3 位码 → 抛出可读中文错误，指明「护照签发国」与该值', () => {
    expect(() =>
      passengerInputSchema.parse({ ...BASE_PASSENGER, passportIssueCountry: 'XXX' }),
    ).toThrow(/护照签发国.*XXX.*未识别的 3 位国家/);
  });
});

// 改乘客的三条通道（补录 / 订正 / 换人）写的是同一个 Passenger.nationality 列，口径必须与建单一致：
// 此前补录、订正死卡 z.string().length(2)（OCR / MRZ 给的 CHN 直接 400），换人却是 max(60)
// （CHN、中文原样入库，导出与送签按 2 位码查表查不到）。
describe('改乘客三通道 · 国家码与建单同口径', () => {
  it('补录：3 位码归一为 2 位（CHN→CN，签发国 mac→MO）', () => {
    const body = selfUpdatePassengerBodySchema.parse({ nationality: 'CHN', passportIssueCountry: 'mac' });
    expect(body.nationality).toBe('CN');
    expect(body.passportIssueCountry).toBe('MO');
  });

  it('订正：3 位码归一、小写 2 位码归一为大写', () => {
    expect(correctPassengerBodySchema.parse({ mode: 'CORRECTION', nationality: 'CHN' }).nationality).toBe('CN');
    expect(correctPassengerBodySchema.parse({ mode: 'CORRECTION', nationality: 'vn' }).nationality).toBe('VN');
  });

  it('换人：3 位码归一，中文等非国家码不再原样入库', () => {
    expect(swapPassengerBodySchema.parse({ mode: 'SWAP', nationality: 'VNM' }).nationality).toBe('VN');
    expect(() => swapPassengerBodySchema.parse({ mode: 'SWAP', nationality: '中国' })).toThrow(
      /国籍.*中国.*不是合法的国家码/,
    );
  });

  it('三条通道对未识别的 3 位码都给出指明字段与值的中文错误', () => {
    expect(() => selfUpdatePassengerBodySchema.parse({ nationality: 'ZZZ' })).toThrow(/国籍.*ZZZ.*未识别/);
    expect(() => selfUpdatePassengerBodySchema.parse({ passportIssueCountry: 'ZZZ' })).toThrow(
      /护照签发国.*ZZZ.*未识别/,
    );
    expect(() => correctPassengerBodySchema.parse({ mode: 'CORRECTION', nationality: 'ZZZ' })).toThrow(
      /国籍.*ZZZ.*未识别/,
    );
    expect(() => swapPassengerBodySchema.parse({ mode: 'SWAP', nationality: 'ZZZ' })).toThrow(/国籍.*ZZZ.*未识别/);
  });
});
