/**
 * 航班时刻的时区折算工具。
 *
 * 背景：`FlightSchedule.departureTime/arrivalTime` 存的是 UTC 时间戳，当地时区另存在
 * `departureTz/arrivalTz`。展示给人看的时刻**必须**按对应 tz 折算——直接切 ISO 串
 * （`toISOString().slice(11,16)`）或用 `getUTCHours()` 会少 8 小时（澳门/北京 +8）、
 * 少 7 小时（越南 +7），行程单、订单详情、名单导出全线错。
 *
 * 反向（当地钟点 → UTC）用于批量改时刻：运营填的是"当地 16:40 起飞"，
 * 落库前要按该班次自己的 tz 折回 UTC。
 */

/** 某个瞬间在指定 IANA 时区的 UTC 偏移（毫秒）。tz 不识别时回退 0（=按 UTC 处理）。 */
function tzOffsetMs(at: Date, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
    // hour12:false 在部分引擎会把午夜给成 "24"，取模归一到 0。
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    return asUtc - at.getTime();
  } catch {
    return 0;
  }
}

/**
 * 'YYYY-MM-DD'（按指定 IANA 时区的当地日）。tz 不识别时回退 UTC 日。
 * tz 为空（调用方没联查到 departureTz）时**按 UTC 折**，不落到运行环境的默认时区——
 * 后者会让同一份导出在开发机和服务器上给出不同日期。
 */
export function localDateISO(d: Date, tz: string | null | undefined): string {
  if (!tz) return d.toISOString().slice(0, 10);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * 'HH:mm'（按指定 IANA 时区的当地钟点，24 小时制）。tz 不识别或为空时回退 UTC 钟点
 * （不落到运行环境默认时区——理由同 localDateISO）。
 */
export function localHHMM(d: Date, tz: string | null | undefined): string {
  const offset = tz ? tzOffsetMs(d, tz) : 0;
  const shifted = new Date(d.getTime() + offset);
  return `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD HH:mm'（当地日 + 当地钟点）。 */
export function localDateTime(d: Date, tz: string | null | undefined): string {
  return `${localDateISO(d, tz)} ${localHHMM(d, tz)}`;
}

/**
 * 当地钟点 → UTC 时间戳。
 * @param dateISO 当地日 'YYYY-MM-DD'
 * @param hhmm    当地钟点 'HH:mm'
 * @param tz      IANA 时区
 *
 * 先按"当成 UTC"猜一次，再用猜出来那一刻的实际偏移修正；迭代两轮以覆盖 DST 切换日
 * （本项目现役时区 Asia/Macau / Asia/Ho_Chi_Minh / Asia/Shanghai 都无 DST，
 * 两轮是为了将来加别的时区时不出错）。
 */
export function localToUtc(dateISO: string, hhmm: string, tz: string): Date {
  const [y, m, d] = dateISO.split('-').map(Number);
  const [hh, mi] = hhmm.split(':').map(Number);
  if (![y, m, d, hh, mi].every(Number.isFinite)) {
    throw new Error(`无法解析当地时刻：${dateISO} ${hhmm}`);
  }
  const wall = Date.UTC(y, m - 1, d, hh, mi);
  let ts = wall;
  for (let i = 0; i < 2; i += 1) {
    ts = wall - tzOffsetMs(new Date(ts), tz);
  }
  return new Date(ts);
}
