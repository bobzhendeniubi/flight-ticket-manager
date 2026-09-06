/**
 * 机场 / 城市代码 → 中文名 · 国家 · IANA 时区 —— 全站单一事实来源。
 *
 * 背景：sales-web、miniprogram 曾各自写死一份「只认 MFM/DAD」的机场表，公司马上开
 * 第二条直飞航线后就要同时卖两条线，前端不该硬编码目的地。这张表覆盖公司业务半径内
 * 常见的出发/到达点（含现有主力航线 + 计划扩展的东南亚/东北亚/两岸三地点），新开航线
 * 落到已有条目就不需要再改前端——真出现表里没有的新机场，也只是这里补一行。
 *
 * 与 backend/src/lib/flight-time.ts 的关系：flight-time.ts 只管「UTC ⇌ 当地钟点」的
 * 折算算法，不认识机场；这张表反过来只管「代码 → 展示信息」，两者正交、各管一层。
 *
 * `city` 字段单独存在的原因：极少数酒店城市码不是机场三字码（如「会安 HOA」——
 * 会安本身没有机场，最近机场是岘港 DAD，历史上一直用 HOA 当酒店城市码）。
 * 这类非机场码走 CITY_NAME_OVERRIDES，不进 AIRPORTS。
 */
export interface AirportInfo {
  code: string;
  /** 中文名（机场/城市展示名，如「岘港」「东京(成田)」） */
  name: string;
  /** 城市名（多数与 name 相同，供酒店城市等场景复用） */
  city: string;
  country: string;
  /** IANA 时区 */
  tz: string;
}

export const AIRPORTS: Record<string, AirportInfo> = {
  // 现役主力航线
  MFM: { code: 'MFM', name: '澳门', city: '澳门', country: '中国澳门', tz: 'Asia/Macau' },
  DAD: { code: 'DAD', name: '岘港', city: '岘港', country: '越南', tz: 'Asia/Ho_Chi_Minh' },

  // 中国港澳台 / 大陆常见出发地
  HKG: { code: 'HKG', name: '香港', city: '香港', country: '中国香港', tz: 'Asia/Hong_Kong' },
  SZX: { code: 'SZX', name: '深圳', city: '深圳', country: '中国', tz: 'Asia/Shanghai' },
  CAN: { code: 'CAN', name: '广州', city: '广州', country: '中国', tz: 'Asia/Shanghai' },
  SYX: { code: 'SYX', name: '三亚', city: '三亚', country: '中国', tz: 'Asia/Shanghai' },
  HAK: { code: 'HAK', name: '海口', city: '海口', country: '中国', tz: 'Asia/Shanghai' },
  CSX: { code: 'CSX', name: '长沙', city: '长沙', country: '中国', tz: 'Asia/Shanghai' },
  PEK: { code: 'PEK', name: '北京', city: '北京', country: '中国', tz: 'Asia/Shanghai' },
  PVG: { code: 'PVG', name: '上海', city: '上海', country: '中国', tz: 'Asia/Shanghai' },

  // 东北亚
  KIX: { code: 'KIX', name: '大阪', city: '大阪', country: '日本', tz: 'Asia/Tokyo' },
  NRT: { code: 'NRT', name: '东京(成田)', city: '东京', country: '日本', tz: 'Asia/Tokyo' },
  ICN: { code: 'ICN', name: '首尔(仁川)', city: '首尔', country: '韩国', tz: 'Asia/Seoul' },

  // 东南亚
  BKK: { code: 'BKK', name: '曼谷', city: '曼谷', country: '泰国', tz: 'Asia/Bangkok' },
  HKT: { code: 'HKT', name: '普吉岛', city: '普吉岛', country: '泰国', tz: 'Asia/Bangkok' },
  KUL: { code: 'KUL', name: '吉隆坡', city: '吉隆坡', country: '马来西亚', tz: 'Asia/Kuala_Lumpur' },
  BKI: { code: 'BKI', name: '亚庇', city: '亚庇', country: '马来西亚', tz: 'Asia/Kuching' },
  SGN: { code: 'SGN', name: '胡志明市', city: '胡志明市', country: '越南', tz: 'Asia/Ho_Chi_Minh' },
  HAN: { code: 'HAN', name: '河内', city: '河内', country: '越南', tz: 'Asia/Ho_Chi_Minh' },
  CXR: { code: 'CXR', name: '芽庄', city: '芽庄', country: '越南', tz: 'Asia/Ho_Chi_Minh' },
  PQC: { code: 'PQC', name: '富国岛', city: '富国岛', country: '越南', tz: 'Asia/Ho_Chi_Minh' },
  SIN: { code: 'SIN', name: '新加坡', city: '新加坡', country: '新加坡', tz: 'Asia/Singapore' },
  MNL: { code: 'MNL', name: '马尼拉', city: '马尼拉', country: '菲律宾', tz: 'Asia/Manila' },
  CEB: { code: 'CEB', name: '宿务', city: '宿务', country: '菲律宾', tz: 'Asia/Manila' },
  DPS: { code: 'DPS', name: '巴厘岛(登巴萨)', city: '巴厘岛', country: '印度尼西亚', tz: 'Asia/Makassar' },
};

/**
 * 非机场三字码的城市展示名覆盖（酒店城市码专用）。
 * HOA = 会安：无机场，业务上一直挂靠岘港航线，酒店城市码历史遗留为 HOA。
 */
export const CITY_NAME_OVERRIDES: Record<string, string> = {
  HOA: '会安',
};

/** 查已知机场信息；未收录的三字码回 null（调用方决定兜底展示）。 */
export function airportInfo(code: string): AirportInfo | null {
  return AIRPORTS[code] ?? null;
}

/**
 * 机场/城市代码 → 中文城市名。优先机场表，其次覆盖表，都没有就原样回代码——
 * 保证新航线/新城市在没来得及补录这张表时也不会展示成空白或报错。
 */
export function cityName(code: string): string {
  return AIRPORTS[code]?.city ?? CITY_NAME_OVERRIDES[code] ?? code;
}

/**
 * 兜底 AirportInfo：数据库里出现了这张表还没收录的三字码时（新航线上线但没来得及
 * 补表），用代码本身占位展示信息，而不是抛错把整个公开端点打挂。tz 回退
 * Asia/Shanghai——与 flight-time.ts 的 FALLBACK_OFFSET_MINUTES 口径一致。
 */
export function resolveAirport(code: string): AirportInfo {
  return AIRPORTS[code] ?? { code, name: code, city: code, country: '', tz: 'Asia/Shanghai' };
}
