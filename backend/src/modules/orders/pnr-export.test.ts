/**
 * pnr-export.ts · 单元测试（vitest）
 *
 * 0709 票务岗反馈两个确诊 bug 的回归测试：
 *   1. 姓名兜底拆分——fullName 常见 "CHEN/HAOLIANG" 斜线格式（OCR/OTA/老数据），
 *      兜底切分需同时认空格与斜线；lastName/firstName 为空串也要走兜底（不能只判 null）。
 *   2. PTC 按「出发日 − 出生日期」实足年龄自动推算（<2 INF / 2–<12 CHD / ≥12 ADT），
 *      生日或出发日缺失（纯地面单）时回退录入的 passengerType。
 *
 * Title 自动生成新口径（票务岗）：航司系统只认 MR/MS，人名后带称谓——手录优先，
 * 否则按性别派生（M→MR、F→MS），所有年龄段一致（儿童/婴儿也 MR/MS，不再出 MSTR/MISS），性别缺失留空。
 *
 * 导出文件名 DD/MON 取去程航班出发日；纯地面单（无航班行）回退今天。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Passenger } from '@prisma/client';
import {
  passengerToRow,
  derivePtcByAge,
  derivePtcByLocalDate,
  earliestFlightDeparture,
  pnrExportFilename,
} from './pnr-export.js';

const D = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

/** 最小可用 Passenger fixture——只需 passengerToRow 实际读取的字段。*/
function fixturePassenger(overrides: Partial<Passenger> = {}): Passenger {
  return {
    id: 'p1',
    orderId: 'o1',
    fullName: 'WANG LIANBO',
    lastName: null,
    firstName: null,
    title: null,
    gender: null,
    documentType: 'PASSPORT',
    documentNumber: 'EN7208993',
    dateOfBirth: null,
    placeOfBirth: null,
    nationality: 'CN',
    passengerType: 'ADULT',
    chineseName: null,
    passportIssueDate: null,
    passportIssueCountry: null,
    passportIssuePlace: null,
    passportExpiry: null,
    visaNumber: null,
    visaType: null,
    visaIssueDate: null,
    visaEffectiveDate: null,
    visaExpiry: null,
    visaPlaceOfIssue: null,
    visaCountryOfApplication: null,
    addressType: null,
    addressDetails: null,
    addressCity: null,
    addressState: null,
    addressCountry: null,
    addressZip: null,
    mealPreference: null,
    needsWheelchair: false,
    needsInfantBassinet: false,
    bedPref: null,
    passportPhotoUrl: null,
    pnr: null,
    eticketNumber: null,
    createdAt: D('2026-01-01'),
    updatedAt: D('2026-01-01'),
    ...overrides,
  } as unknown as Passenger;
}

describe('姓名拆分 — 兜底切分需同时认空格与斜线', () => {
  it('斜线格式 "CHEN/HAOLIANG" → CHEN + HAOLIANG（不再整串掉进 Last Name）', () => {
    const row = passengerToRow(fixturePassenger({ fullName: 'CHEN/HAOLIANG' }));
    expect(row.lastName).toBe('CHEN');
    expect(row.firstName).toBe('HAOLIANG');
  });

  it('斜线格式多词名 "WONG/TAK MING" → WONG + TAK MING', () => {
    const row = passengerToRow(fixturePassenger({ fullName: 'WONG/TAK MING' }));
    expect(row.lastName).toBe('WONG');
    expect(row.firstName).toBe('TAK MING');
  });

  it('空格格式仍按原逻辑切分（不回归）', () => {
    const row = passengerToRow(fixturePassenger({ fullName: 'WANG LIANBO' }));
    expect(row.lastName).toBe('WANG');
    expect(row.firstName).toBe('LIANBO');
  });

  it('lastName 为空串（非 null）也视同缺失，走 fullName 兜底', () => {
    const row = passengerToRow(
      fixturePassenger({ fullName: 'WANG LIANBO', lastName: '', firstName: 'LIANBO' }),
    );
    expect(row.lastName).toBe('WANG');
    expect(row.firstName).toBe('LIANBO');
  });

  it('firstName 为空串（非 null）、lastName 有值 → firstName 走 fullName 兜底', () => {
    const row = passengerToRow(
      fixturePassenger({ fullName: 'WONG/TAK MING', lastName: 'WONG', firstName: '' }),
    );
    expect(row.lastName).toBe('WONG');
    expect(row.firstName).toBe('TAK MING');
  });

  it('拆分字段齐全时优先使用录入值，不受 fullName 影响', () => {
    const row = passengerToRow(
      fixturePassenger({ fullName: '随便什么', lastName: 'WANG', firstName: 'LIANBO' }),
    );
    expect(row.lastName).toBe('WANG');
    expect(row.firstName).toBe('LIANBO');
  });
});

describe('derivePtcByAge — 按「出发日 − 出生日期」实足年龄推算', () => {
  const departure = D('2026-07-13');

  it('差一天不满 2 岁 → INF', () => {
    expect(derivePtcByAge(D('2024-07-14'), departure, 'ADULT')).toBe('INF');
  });

  it('满 2 岁当天 → CHD（不是 INF）', () => {
    expect(derivePtcByAge(D('2024-07-13'), departure, 'ADULT')).toBe('CHD');
  });

  it('差一天不满 12 岁 → CHD', () => {
    expect(derivePtcByAge(D('2014-07-14'), departure, 'ADULT')).toBe('CHD');
  });

  it('满 12 岁当天 → ADT（不是 CHD）', () => {
    expect(derivePtcByAge(D('2014-07-13'), departure, 'ADULT')).toBe('ADT');
  });

  it('无生日 → 回退录入的 passengerType', () => {
    expect(derivePtcByAge(null, departure, 'CHILD')).toBe('CHD');
    expect(derivePtcByAge(undefined, departure, 'INFANT')).toBe('INF');
  });

  it('无出发日（纯地面单取不到航班）→ 回退录入的 passengerType', () => {
    expect(derivePtcByAge(D('1990-01-01'), null, 'ADULT')).toBe('ADT');
    expect(derivePtcByAge(D('1990-01-01'), undefined, 'CHILD')).toBe('CHD');
  });

  it('生日晚于出发日（数据异常）→ 回退录入值，不产生负年龄', () => {
    expect(derivePtcByAge(D('2027-01-01'), departure, 'ADULT')).toBe('ADT');
  });
});

describe('passengerToRow — Title 自动生成（统一 MR/MS，不分年龄段、无儿童称谓）', () => {
  const departure = D('2026-07-13');

  it('成人男（ADT）未录入 Title → MR', () => {
    const row = passengerToRow(
      fixturePassenger({ dateOfBirth: D('1990-01-01'), gender: 'M', title: null }),
      departure,
    );
    expect(row.ptc).toBe('ADT');
    expect(row.title).toBe('MR');
  });

  it('成人女（ADT）未录入 Title → MS', () => {
    const row = passengerToRow(
      fixturePassenger({ dateOfBirth: D('1990-01-01'), gender: 'F', title: null }),
      departure,
    );
    expect(row.ptc).toBe('ADT');
    expect(row.title).toBe('MS');
  });

  it('儿童男（CHD）也给 MR（不再出 MSTR）', () => {
    const row = passengerToRow(
      fixturePassenger({ dateOfBirth: D('2020-01-01'), gender: 'M', title: null }),
      departure,
    );
    expect(row.ptc).toBe('CHD');
    expect(row.title).toBe('MR');
  });

  it('儿童女（CHD）也给 MS（不再出 MISS）', () => {
    const row = passengerToRow(
      fixturePassenger({ dateOfBirth: D('2020-01-01'), gender: 'F', title: null }),
      departure,
    );
    expect(row.ptc).toBe('CHD');
    expect(row.title).toBe('MS');
  });

  it('婴儿男（INF）也给 MR（不再出 MSTR）', () => {
    const row = passengerToRow(
      fixturePassenger({ dateOfBirth: D('2025-06-01'), gender: 'M', title: null }),
      departure,
    );
    expect(row.ptc).toBe('INF');
    expect(row.title).toBe('MR');
  });

  it('性别缺失 → Title 留空（任何年龄段一致）', () => {
    const child = passengerToRow(
      fixturePassenger({ dateOfBirth: D('2020-01-01'), gender: null, title: null }),
      departure,
    );
    expect(child.title).toBe('');
    const adult = passengerToRow(
      fixturePassenger({ dateOfBirth: D('1990-01-01'), gender: null, title: null }),
      departure,
    );
    expect(adult.title).toBe('');
  });

  it('手录 Title 优先——原样保留，不被性别派生覆盖', () => {
    const row = passengerToRow(
      fixturePassenger({ dateOfBirth: D('1990-01-01'), gender: 'F', title: 'DR' }),
      departure,
    );
    expect(row.title).toBe('DR');
  });
});

describe('earliestFlightDeparture — 取订单 FLIGHT 行最早出发时间', () => {
  it('多段机票取最早的出发时间（去程）', () => {
    const items = [
      { kind: 'FLIGHT', flightSchedule: { departureTime: D('2026-07-14') } },
      { kind: 'FLIGHT', flightSchedule: { departureTime: D('2026-07-13') } },
    ];
    expect(earliestFlightDeparture(items)).toEqual(D('2026-07-13'));
  });

  it('忽略非 FLIGHT 行', () => {
    const items = [
      { kind: 'HOTEL', flightSchedule: null },
      { kind: 'FLIGHT', flightSchedule: { departureTime: D('2026-07-13') } },
    ];
    expect(earliestFlightDeparture(items)).toEqual(D('2026-07-13'));
  });

  it('无 FLIGHT 行（纯地面单）→ null', () => {
    expect(earliestFlightDeparture([{ kind: 'HOTEL', flightSchedule: null }])).toBeNull();
    expect(earliestFlightDeparture([])).toBeNull();
    expect(earliestFlightDeparture(undefined)).toBeNull();
  });
});

describe('earliestFlightDeparture — 红眼航班按出发地当地日折算，而非裸 UTC（C-6）', () => {
  it('当地日与 UTC 日不同时，返回值折到当地日（UTC 零点表示，供 getUTC* 直读）', () => {
    // 当地时间（Asia/Ho_Chi_Minh, UTC+7）2026-07-13 00:40 起飞 == UTC 2026-07-12T17:40Z。
    const items = [
      {
        kind: 'FLIGHT',
        flightSchedule: {
          departureTime: new Date('2026-07-12T17:40:00.000Z'),
          departureTz: 'Asia/Ho_Chi_Minh',
        },
      },
    ];
    expect(earliestFlightDeparture(items)).toEqual(D('2026-07-13'));
  });

  it('多段机票仍按真实瞬时先后取最早一段，只是把该段折成当地日', () => {
    const items = [
      // 更晚出发的一段（当地日 07-14）
      {
        kind: 'FLIGHT',
        flightSchedule: {
          departureTime: new Date('2026-07-13T17:00:00.000Z'),
          departureTz: 'Asia/Ho_Chi_Minh',
        },
      },
      // 真正最早的一段：UTC 07-12 17:40 == 当地 07-13 00:40
      {
        kind: 'FLIGHT',
        flightSchedule: {
          departureTime: new Date('2026-07-12T17:40:00.000Z'),
          departureTz: 'Asia/Ho_Chi_Minh',
        },
      },
    ];
    expect(earliestFlightDeparture(items)).toEqual(D('2026-07-13'));
  });

  it('未联查 departureTz 的旧调用方 → 回退裸 UTC（行为不变，待各自 select 补上 tz 才吃到修复）', () => {
    const items = [{ kind: 'FLIGHT', flightSchedule: { departureTime: D('2026-07-12') } }];
    expect(earliestFlightDeparture(items)).toEqual(D('2026-07-12'));
  });
});

describe('端到端：红眼航班的 PTC 与 PNR 文件名按当地日而非 UTC 日判定（C-6）', () => {
  it('乘客恰好在当地出发日当天满 12 岁 → ADT，不会被"UTC 早一天"误判成 CHD', () => {
    // 当地出发日 2026-07-13；出生日期 2014-07-13 → 当地口径恰好满 12 岁。
    // 若仍按裸 UTC（07-12）判，实足年龄会被误判为差一天不满 12 岁 → 误判成 CHD。
    const departureLocal = earliestFlightDeparture([
      {
        kind: 'FLIGHT',
        flightSchedule: {
          departureTime: new Date('2026-07-12T17:40:00.000Z'),
          departureTz: 'Asia/Ho_Chi_Minh',
        },
      },
    ]);
    expect(derivePtcByAge(D('2014-07-13'), departureLocal, 'ADULT')).toBe('ADT');
  });

  it('PNR 文件名按当地出发日而非 UTC 日（红眼航班不再早报一天）', () => {
    const departureLocal = earliestFlightDeparture([
      {
        kind: 'FLIGHT',
        flightSchedule: {
          departureTime: new Date('2026-07-12T17:40:00.000Z'),
          departureTz: 'Asia/Ho_Chi_Minh',
        },
      },
    ]);
    expect(pnrExportFilename('WT2026', departureLocal)).toBe('13JUL WT2026.xlsx');
  });
});

describe('derivePtcByLocalDate — 直接接收当地日字符串（C-6 新 helper：dob, 当地出发日 YYYY-MM-DD, fallbackPassengerType）', () => {
  it('与「先折算出发地当地日、再传给 derivePtcByAge」等价', () => {
    expect(derivePtcByLocalDate(D('2014-07-13'), '2026-07-13', 'ADULT')).toBe('ADT');
    expect(derivePtcByLocalDate(D('2014-07-14'), '2026-07-13', 'ADULT')).toBe('CHD');
  });

  it('边界值与 derivePtcByAge 同口径：<2 INF / 2–<12 CHD / ≥12 ADT', () => {
    expect(derivePtcByLocalDate(D('2024-07-13'), '2026-07-13', 'ADULT')).toBe('CHD');
    expect(derivePtcByLocalDate(D('2024-07-14'), '2026-07-13', 'ADULT')).toBe('INF');
  });

  it('缺生日或缺当地出发日 → 回退录入的 passengerType', () => {
    expect(derivePtcByLocalDate(null, '2026-07-13', 'CHILD')).toBe('CHD');
    expect(derivePtcByLocalDate(D('1990-01-01'), null, 'INFANT')).toBe('INF');
    expect(derivePtcByLocalDate(D('1990-01-01'), undefined, 'ADULT')).toBe('ADT');
  });

  it('生日晚于当地出发日（数据异常）→ 回退录入值，不产生负年龄', () => {
    expect(derivePtcByLocalDate(D('2027-01-01'), '2026-07-13', 'ADULT')).toBe('ADT');
  });
});

describe('passengerToRow — 无出发日时端到端回退（纯地面单场景）', () => {
  it('不传 departureDate → PTC 回退录入的 passengerType，不抛错', () => {
    const row = passengerToRow(
      fixturePassenger({ dateOfBirth: D('2020-01-01'), passengerType: 'CHILD' }),
    );
    expect(row.ptc).toBe('CHD');
  });
});

describe('pnrExportFilename — DD/MON 取去程出发日，取不到回退今天', () => {
  it('有出发日 → 用出发日的 DD/MON（UTC，与列内日期一致）', () => {
    expect(pnrExportFilename('WT2026', D('2026-07-13'))).toBe('13JUL WT2026.xlsx');
  });

  it('月份边界正确（12 月 → DEC，一位数日补零）', () => {
    expect(pnrExportFilename('WT2026', D('2026-12-05'))).toBe('05DEC WT2026.xlsx');
  });

  it('无出发日（null）→ 回退今天并保持原格式 {DD}{MON} {orderNumber}.xlsx', () => {
    const name = pnrExportFilename('WT2026', null);
    expect(name).toMatch(/^\d{2}[A-Z]{3} WT2026\.xlsx$/);
  });

  it('省略 departureDate 参数（旧调用形态）→ 同样回退今天', () => {
    expect(pnrExportFilename('WT2026')).toMatch(/^\d{2}[A-Z]{3} WT2026\.xlsx$/);
  });

  describe('回退今天按北京业务日（容器 TZ=UTC 也不能落到前一天）', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('北京已跨到 13 日凌晨（UTC 还是 12 日 16:30）→ 13JUL 而非 12JUL', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-12T16:30:00.000Z'));
      expect(pnrExportFilename('WT2026', null)).toBe('13JUL WT2026.xlsx');
    });

    it('北京与 UTC 同日时口径不变', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-13T06:00:00.000Z'));
      expect(pnrExportFilename('WT2026', null)).toBe('13JUL WT2026.xlsx');
    });
  });
});
