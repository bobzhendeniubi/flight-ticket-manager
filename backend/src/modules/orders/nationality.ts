/**
 * 国籍 / 国家字段统一规范化为 ISO-3166-1 alpha-3。
 *
 * 共享给 pnr-export.ts（航司 PNR 提交格式）和 orders.export.ts（整班机订单导出）。
 * 数据库存的可能是 alpha-2（CN/HK）、中文（中国/香港）或已经是 alpha-3（CHN/HKG）。
 * 我们在导出层统一转 alpha-3；未命中的原样返回，避免阻塞导出。
 *
 * 覆盖：东南亚 + 港澳台 + 主流出行国家。漏的可以后补。
 */

export const NATIONALITY_ALPHA3: Record<string, string> = {
  // 港澳台 + 中国（sales-web 默认 4 项）
  CN: 'CHN', HK: 'HKG', MO: 'MAC', TW: 'TWN',
  // 东南亚 / 东亚（包机主要市场）
  VN: 'VNM', JP: 'JPN', KR: 'KOR', TH: 'THA', SG: 'SGP', MY: 'MYS',
  ID: 'IDN', PH: 'PHL', KH: 'KHM', LA: 'LAO', MM: 'MMR',
  // 主流欧美
  US: 'USA', GB: 'GBR', UK: 'GBR', CA: 'CAN', AU: 'AUS', NZ: 'NZL',
  FR: 'FRA', DE: 'DEU', IT: 'ITA', ES: 'ESP', PT: 'PRT', NL: 'NLD',
  BE: 'BEL', CH: 'CHE', AT: 'AUT', IE: 'IRL', SE: 'SWE', NO: 'NOR',
  DK: 'DNK', FI: 'FIN', GR: 'GRC',
  // 其他常见
  IN: 'IND', RU: 'RUS', TR: 'TUR', AE: 'ARE', SA: 'SAU',
  BD: 'BGD', NP: 'NPL', LK: 'LKA', PK: 'PAK',
  BR: 'BRA', MX: 'MEX', AR: 'ARG', ZA: 'ZAF', EG: 'EGY',
  // 中文 → alpha-3（兼容散客手填中文）
  中国: 'CHN', 中国大陆: 'CHN',
  香港: 'HKG', 中国香港: 'HKG',
  澳门: 'MAC', 中国澳门: 'MAC',
  台湾: 'TWN', 中国台湾: 'TWN',
  越南: 'VNM', 日本: 'JPN', 韩国: 'KOR',
  泰国: 'THA', 新加坡: 'SGP', 马来西亚: 'MYS',
  印度尼西亚: 'IDN', 印尼: 'IDN', 菲律宾: 'PHL',
  柬埔寨: 'KHM', 老挝: 'LAO', 缅甸: 'MMR',
  美国: 'USA', 英国: 'GBR', 加拿大: 'CAN',
  澳大利亚: 'AUS', 澳洲: 'AUS', 新西兰: 'NZL',
  法国: 'FRA', 德国: 'DEU', 意大利: 'ITA', 西班牙: 'ESP',
  葡萄牙: 'PRT', 荷兰: 'NLD', 比利时: 'BEL', 瑞士: 'CHE',
  奥地利: 'AUT', 爱尔兰: 'IRL', 瑞典: 'SWE', 挪威: 'NOR',
  丹麦: 'DNK', 芬兰: 'FIN', 希腊: 'GRC',
  印度: 'IND', 俄罗斯: 'RUS', 土耳其: 'TUR',
  阿联酋: 'ARE', 沙特阿拉伯: 'SAU',
  孟加拉国: 'BGD', 尼泊尔: 'NPL', 斯里兰卡: 'LKA', 巴基斯坦: 'PAK',
  巴西: 'BRA', 墨西哥: 'MEX', 阿根廷: 'ARG', 南非: 'ZAF', 埃及: 'EGY',
};

const ALPHA3_SET = new Set(Object.values(NATIONALITY_ALPHA3));

/** 国籍 / 国家字段 → ISO-3166-1 alpha-3（航司 PNR 要求）。未命中原样返回。 */
export function toAlpha3(input: string | null | undefined): string {
  if (!input) return '';
  const trimmed = input.trim();
  if (!trimmed) return '';
  // 已经是 alpha-3 → pass through（避免再查表）
  const upper = trimmed.toUpperCase();
  if (/^[A-Z]{3}$/.test(upper) && ALPHA3_SET.has(upper)) return upper;
  // alpha-2 → alpha-3
  if (NATIONALITY_ALPHA3[upper]) return NATIONALITY_ALPHA3[upper];
  // 中文 → alpha-3（trim 后原文，不 upper）
  if (NATIONALITY_ALPHA3[trimmed]) return NATIONALITY_ALPHA3[trimmed];
  // fallback：原样返回，让 ops 看到能修
  return trimmed;
}
