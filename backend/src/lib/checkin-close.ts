/**
 * 关柜时刻 —— no-show 判定的时间锚点。
 *
 * 业务口径（行业惯例，已拍板）：客人能不能登机，看的是**值机柜台关没关**，不是飞机推没推出去。
 * 国内航班惯例是起飞前 45 分钟关柜；柜台一关，人再来也上不去，那一刻就该按 no-show 处理。
 * 旧口径卡在「起飞时刻」，票务每次都要多等这 45 分钟才敢标记，航司名单早就发过来了。
 *
 * 为什么是「提前多少分钟」而不是每班填一个关柜时间点：
 *   关柜时刻是从起飞时刻派生的，改点时它自动跟着走；每班手填一个绝对时间点，
 *   航司一改点就得逐班再改一次，必然漏改成脏数据。
 *   个别班次（包机 / 特殊口岸）关柜规则不同 → 在 FlightSchedule.checkinCloseMinutes 单独填一个数覆盖，
 *   不填（null）走系统默认。
 *
 * ⚠ 时区：departureTime 存的是真 UTC 瞬间（departureTz 只用于**展示**折算），
 * 关柜时刻是它减去一个时长，同样是真 UTC 瞬间 —— 可以直接与 Date.now() 比。
 * 要展示给人看时照旧走 lib/flight-time.ts 折算成当地钟点。
 */

/** 系统默认关柜提前分钟数（国内航班惯例）。班次没单独配置时一律用它。 */
export const DEFAULT_CHECKIN_CLOSE_MINUTES = 45;

/**
 * 该班次实际生效的关柜提前分钟数：班次自己配了就用班次的，没配（null/undefined）用系统默认。
 * 负数 / 非有限值当成没配 —— 脏数据不该把关柜时刻推到起飞之后（那等于比旧口径还晚才能标）。
 */
export function resolveCheckinCloseMinutes(scheduleValue: number | null | undefined): number {
  if (typeof scheduleValue !== 'number' || !Number.isFinite(scheduleValue) || scheduleValue < 0) {
    return DEFAULT_CHECKIN_CLOSE_MINUTES;
  }
  return scheduleValue;
}

/** 关柜时刻（UTC 瞬间）= 起飞时刻 − 生效的关柜提前分钟数。 */
export function checkinCloseAt(departureTime: Date, scheduleValue: number | null | undefined): Date {
  return new Date(departureTime.getTime() - resolveCheckinCloseMinutes(scheduleValue) * 60_000);
}

/** 该班次此刻是否**已关柜**（刚好到点算已关）。now 可注入，便于测试。 */
export function isCheckinClosed(
  departureTime: Date,
  scheduleValue: number | null | undefined,
  now: number = Date.now(),
): boolean {
  return checkinCloseAt(departureTime, scheduleValue).getTime() <= now;
}
