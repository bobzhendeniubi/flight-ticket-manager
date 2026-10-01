/**
 * 改期弹窗住宿预览 · 口径与后端对齐（全部合成数据）。
 *
 *   1. 占房行筛选 = hotelCheckIn 非空 且（hotelRoomTypeId 或 randomStarTier），不看 kind（后端 hotelRows 同条件）；
 *   2. 航段先后按 UTC 瞬间（departureAt）排，老后端没有该字段时回落到「当地日 + 时刻」字串；
 *   3. FOLLOW_TRIP 预览 = 窗口两头锚定新去程/回程日并保留原偏移（后端 planFollowTripHotelStay 同规则）。
 */
import { describe, it, expect } from 'vitest';
import {
  addDaysYmd,
  countNightsBetween,
  daysBetweenYmd,
  isReschedulePreviewHotelRow,
  previewRescheduleStay,
  type RescheduleStayPreviewItem,
} from './reschedule-stay-preview';

const flight = (id: string, date: string, time: string, at: string | null = null): RescheduleStayPreviewItem => ({
  id,
  kind: 'FLIGHT',
  flightScheduleId: `sched-${id}`,
  departureDate: date,
  departureTime: time,
  departureAt: at,
  hotelCheckIn: null,
  hotelCheckOut: null,
  hotelRoomTypeId: null,
  randomStarTier: null,
});
const hotel = (id: string, checkIn: string, checkOut: string | null, over: Partial<RescheduleStayPreviewItem> = {}): RescheduleStayPreviewItem => ({
  id,
  kind: 'HOTEL',
  flightScheduleId: null,
  departureDate: null,
  departureTime: null,
  departureAt: null,
  hotelCheckIn: `${checkIn}T00:00:00.000Z`,
  hotelCheckOut: checkOut ? `${checkOut}T00:00:00.000Z` : null,
  hotelRoomTypeId: 'rt-1',
  randomStarTier: null,
  ...over,
});

describe('日期小工具', () => {
  it('addDaysYmd / daysBetweenYmd / countNightsBetween 按 UTC date-only 算，跨月正确', () => {
    expect(addDaysYmd('2027-09-30', 1)).toBe('2027-10-01');
    expect(addDaysYmd('2027-10-01', -1)).toBe('2027-09-30');
    expect(daysBetweenYmd('2027-09-28', '2027-10-02')).toBe(4);
    expect(countNightsBetween('2027-09-22', '2027-09-24')).toBe(2);
    expect(countNightsBetween('2027-09-22', '2027-09-22')).toBeNull();
    expect(countNightsBetween('2027-9-2', '2027-09-22')).toBeNull();
  });
});

describe('占房行筛选（与后端 hotelRows 同条件）', () => {
  it('盖了房型 / 挂了随机档的行算；两者都没有的行不算；kind 不参与判定', () => {
    expect(isReschedulePreviewHotelRow(hotel('h', '2027-09-22', '2027-09-23'))).toBe(true);
    expect(isReschedulePreviewHotelRow(hotel('h', '2027-09-22', '2027-09-23', { hotelRoomTypeId: null, randomStarTier: 4 }))).toBe(true);
    expect(isReschedulePreviewHotelRow(hotel('h', '2027-09-22', '2027-09-23', { hotelRoomTypeId: null }))).toBe(false);
    expect(isReschedulePreviewHotelRow(hotel('h', '2027-09-22', '2027-09-23', { kind: 'BUNDLE' }))).toBe(true);
    expect(isReschedulePreviewHotelRow({ ...hotel('h', '2027-09-22', '2027-09-23'), hotelCheckIn: null })).toBe(false);
  });

  it('只有「没房型也没随机档」的占日期行 → 预览为 null（后端不会动它，不该给运营看一个假窗口）', () => {
    expect(
      previewRescheduleStay(
        [flight('out', '2027-09-22', '10:00'), hotel('b', '2027-09-22', '2027-09-23', { kind: 'BUNDLE', hotelRoomTypeId: null })],
        'out',
        { date: '2027-09-21', at: null },
      ),
    ).toBeNull();
  });
});

describe('航段先后与 FOLLOW_TRIP 预览', () => {
  const stay = hotel('h', '2027-09-22', '2027-09-23');

  it('带 departureAt：按 UTC 瞬间排，当地日/时刻字串缺失也不影响判去回程', () => {
    // 回程行的当地时刻缺失（老数据），字串比较会把它排到前面；按瞬间它仍是第二段。
    const items = [
      flight('ret', '2027-09-23', '', '2027-09-23T02:00:00.000Z'),
      flight('out', '2027-09-22', '', '2027-09-22T02:00:00.000Z'),
      stay,
    ];
    // 去程 22 → 21：入住跟去程提前一天、离店不动 → 21~23 共 2 晚。
    const preview = previewRescheduleStay(items, 'out', { date: '2027-09-21', at: '2027-09-21T02:00:00.000Z' });
    expect(preview?.current).toEqual({ checkIn: '2027-09-22', checkOut: '2027-09-23', nights: 1 });
    expect(preview?.followTrip).toEqual({ checkIn: '2027-09-21', checkOut: '2027-09-23', nights: 2 });
    expect(preview?.shift).toEqual({ checkIn: '2027-09-21', checkOut: '2027-09-22', nights: 1 });
  });

  it('改期后两段先后互换（去程改到回程之后）：按瞬间重排，新窗口按新顺序锚定', () => {
    const items = [
      flight('out', '2027-09-22', '10:00', '2027-09-22T02:00:00.000Z'),
      flight('ret', '2027-09-23', '10:00', '2027-09-23T02:00:00.000Z'),
      stay,
    ];
    // 去程改到 25 日 → 排序后第一段是原回程（23）、第二段是改后的去程（25）。
    const preview = previewRescheduleStay(items, 'out', { date: '2027-09-25', at: '2027-09-25T02:00:00.000Z' });
    expect(preview?.followTrip).toEqual({ checkIn: '2027-09-23', checkOut: '2027-09-25', nights: 2 });
  });

  it('老后端没有 departureAt：回落到「当地日 + 时刻」字串排序', () => {
    const items = [flight('ret', '2027-09-23', '10:00'), flight('out', '2027-09-22', '10:00'), stay];
    const preview = previewRescheduleStay(items, 'ret', { date: '2027-09-25', at: null });
    expect(preview?.followTrip).toEqual({ checkIn: '2027-09-22', checkOut: '2027-09-25', nights: 3 });
    expect(preview?.shift).toEqual({ checkIn: '2027-09-22', checkOut: '2027-09-23', nights: 1 });
  });

  it('保留原偏移 + 分段住只动两头：次日入住、两家酒店接力', () => {
    const items = [
      flight('out', '2027-09-22', '10:00', '2027-09-22T02:00:00.000Z'),
      flight('ret', '2027-09-26', '10:00', '2027-09-26T02:00:00.000Z'),
      hotel('h1', '2027-09-23', '2027-09-24'),
      hotel('h2', '2027-09-24', '2027-09-26', { hotelRoomTypeId: null, randomStarTier: 4 }),
    ];
    // 回程 26 → 27：窗口 23~26（偏移：入住 +1、离店 0）→ 23~27。
    const preview = previewRescheduleStay(items, 'ret', { date: '2027-09-27', at: '2027-09-27T02:00:00.000Z' });
    expect(preview?.current).toEqual({ checkIn: '2027-09-23', checkOut: '2027-09-26', nights: 3 });
    expect(preview?.followTrip).toEqual({ checkIn: '2027-09-23', checkOut: '2027-09-27', nights: 4 });
  });

  it('单程单 → followTrip 为 null（后端退化为整体平移），shift 仍给', () => {
    const preview = previewRescheduleStay(
      [flight('out', '2027-09-22', '10:00', '2027-09-22T02:00:00.000Z'), stay],
      'out',
      { date: '2027-09-21', at: '2027-09-21T02:00:00.000Z' },
    );
    expect(preview?.followTrip).toBeNull();
    expect(preview?.shift).toEqual({ checkIn: '2027-09-21', checkOut: '2027-09-22', nights: 1 });
  });

  it('还没选新班次 → 只给 current', () => {
    const preview = previewRescheduleStay([flight('out', '2027-09-22', '10:00'), stay], 'out', null);
    expect(preview).toEqual({ current: { checkIn: '2027-09-22', checkOut: '2027-09-23', nights: 1 }, followTrip: null, shift: null });
  });
});
