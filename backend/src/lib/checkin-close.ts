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
 * ── 哪些闸用关柜、哪个动作按起飞 ────────────────────────────────────────────────
 * 分界线只有一句话：**「人还能不能上这班飞机」按关柜；「飞机是不是真的走了」按起飞。**
 *
 * 按**关柜**（关柜一到就生效，也就是起飞前那 45 分钟窗口内已经算数）：
 *   1. 去程能否标 no-show（_assessNoShow 闸 4 / 批量 no-show 的 departed）——
 *      柜台关了客人就登不上机，航司名单也是照关柜出的，没必要再干等到起飞。
 *   2. 释放回程座位（_assessNoShow 闸 5b）—— 关柜后放回库存的座位没人能值机，
 *      它进了余位就是凭空多卖一张。
 *   3. 恢复回程（_assessRestoreReturnLeg）—— 恢复 = 重新占座，关柜后占回来也上不去，
 *      占的是一个交付不了的座位，还白吃掉这一舱一份余位。
 *
 * 按**起飞**（关柜到起飞之间不变）：
 *   4. 已释放回程的「过期作废」（手工作废闸 + 起飞后自动作废 job，见 no-show-void.ts）——
 *      作废是给这一段打终态、承认「座位确实消耗掉了」的事实动作。关柜后飞机还没走，
 *      延误 / 换班次都可能让它最终没走成，这时候打终态就把话说早了；job 另留 2 小时缓冲同理。
 *
 * 于是关柜到起飞之间有一段窗口：**能标 no-show，但既不能释放座位、也不能恢复回程，
 * 还不到作废的时候** —— 这不是漏洞，就是「人已经上不去、飞机还没走」这个事实本身的样子。
 * 闸文案要把这个状态说清楚，别让运营在那儿找一条并不存在的路。
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
