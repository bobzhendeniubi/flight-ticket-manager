/**
 * pnr-export.ts · 单元测试（vitest）
 *
 * 0709 票务岗反馈两个确诊 bug 的回归测试：
 *   1. 姓名兜底拆分——fullName 常见 "CHEN/HAOLIANG" 斜线格式（OCR/OTA/老数据），
 *      兜底切分需同时认空格与斜线；lastName/firstName 为空串也要走兜底（不能只判 null）。
 *   2. PTC 按「出发日 − 出生日期」实足年龄自动推算（<2 INF / 2–<12 CHD / ≥12 ADT），
 *      生日或出发日缺失（纯地面单）时回退录入的 passengerType；
 *      派生为 CHD/INF 且 Title 缺失时按性别给 MSTR/MISS，成人缺失维持原样（留空）。
 */
import { describe, it, expect } from 'vitest';
import type { Passenger } from '@prisma/client';
import { passengerToRow, derivePtcByAge, earliestFlightDeparture } from './pnr-export.js';

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

describe('passengerToRow — PTC 联动 Title（CHD/INF 缺 Title 按性别给 MSTR/MISS）', () => {
  const departure = D('2026-07-13');

  it('派生为 CHD 且未录入 Title、性别男 → MSTR', () => {
    const row = passengerToRow(
      fixturePassenger({ dateOfBirth: D('2020-01-01'), gender: 'M', title: null }),
      departure,
    );
    expect(row.ptc).toBe('CHD');
    expect(row.title).toBe('MSTR');
  });

  it('派生为 CHD 且未录入 Title、性别女 → MISS', () => {
    const row = passengerToRow(
      fixturePassenger({ dateOfBirth: D('2020-01-01'), gender: 'F', title: null }),
      departure,
    );
    expect(row.ptc).toBe('CHD');
    expect(row.title).toBe('MISS');
  });

  it('派生为 INF 且未录入 Title、性别男 → MSTR', () => {
    const row = passengerToRow(
      fixturePassenger({ dateOfBirth: D('2025-06-01'), gender: 'M', title: null }),
      departure,
    );
    expect(row.ptc).toBe('INF');
    expect(row.title).toBe('MSTR');
  });

  it('已录入 Title 时不覆盖，原样保留', () => {
    const row = passengerToRow(
      fixturePassenger({ dateOfBirth: D('2020-01-01'), gender: 'M', title: 'MSTR' }),
      departure,
    );
    expect(row.title).toBe('MSTR');
  });

  it('成人（ADT）缺 Title 维持现状——留空，不联动派生', () => {
    const row = passengerToRow(
      fixturePassenger({ dateOfBirth: D('1990-01-01'), gender: 'M', title: null }),
      departure,
    );
    expect(row.ptc).toBe('ADT');
    expect(row.title).toBe('');
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

describe('passengerToRow — 无出发日时端到端回退（纯地面单场景）', () => {
  it('不传 departureDate → PTC 回退录入的 passengerType，不抛错', () => {
    const row = passengerToRow(
      fixturePassenger({ dateOfBirth: D('2020-01-01'), passengerType: 'CHILD' }),
    );
    expect(row.ptc).toBe('CHD');
  });
});
