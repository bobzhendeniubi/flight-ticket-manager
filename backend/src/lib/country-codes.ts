/**
 * ISO 3166-1 国家/地区码工具——3 位字母码（alpha-3）→ 2 位字母码（alpha-2）全量映射。
 *
 * 背景：录单/批量建单的 nationality、passportIssueCountry 等字段权威口径是 2 位码
 * （与 admin-web OTA 名单解析器 parseOtaRoster.ts 的输出口径一致）。OTA 名单、护照 OCR、
 * 代理侧 API 等非受控输入常见 3 位码（护照 MRZ 本身就用 3 位，如 CHN/USA/VNM），此前
 * schema 用 z.string().length(2) 死板拒绝，整批 400 且报错笼统（"Request validation failed"）。
 * 现由本模块提供归一化：3 位码查表转 2 位；查不到的 3 位码/非法输入交由调用方拼可读错误。
 *
 * 表来自 ISO 3166-1 标准全集（含历史罕见地区码），与 admin-web/src/lib/parseOtaRoster.ts
 * 的同名映射保持数据口径一致（两端各自维护一份，未抽公共包——两个独立前后端项目无共享
 * TS 包基建，重复一份小表比引入跨项目依赖更简单，YAGNI）。
 */

/** alpha-3 → alpha-2，全量 ISO 3166-1。 */
export const COUNTRY_ALPHA3_TO_ALPHA2: Readonly<Record<string, string>> = {
  AND: 'AD', ARE: 'AE', AFG: 'AF', ATG: 'AG', AIA: 'AI', ALB: 'AL', ARM: 'AM',
  AGO: 'AO', ATA: 'AQ', ARG: 'AR', ASM: 'AS', AUT: 'AT', AUS: 'AU', ABW: 'AW',
  ALA: 'AX', AZE: 'AZ', BIH: 'BA', BRB: 'BB', BGD: 'BD', BEL: 'BE', BFA: 'BF',
  BGR: 'BG', BHR: 'BH', BDI: 'BI', BEN: 'BJ', BLM: 'BL', BMU: 'BM', BRN: 'BN',
  BOL: 'BO', BES: 'BQ', BRA: 'BR', BHS: 'BS', BTN: 'BT', BVT: 'BV', BWA: 'BW',
  BLR: 'BY', BLZ: 'BZ', CAN: 'CA', CCK: 'CC', COD: 'CD', CAF: 'CF', COG: 'CG',
  CHE: 'CH', CIV: 'CI', COK: 'CK', CHL: 'CL', CMR: 'CM', CHN: 'CN', COL: 'CO',
  CRI: 'CR', CUB: 'CU', CPV: 'CV', CUW: 'CW', CXR: 'CX', CYP: 'CY', CZE: 'CZ',
  DEU: 'DE', DJI: 'DJ', DNK: 'DK', DMA: 'DM', DOM: 'DO', DZA: 'DZ', ECU: 'EC',
  EST: 'EE', EGY: 'EG', ESH: 'EH', ERI: 'ER', ESP: 'ES', ETH: 'ET', FIN: 'FI',
  FJI: 'FJ', FLK: 'FK', FSM: 'FM', FRO: 'FO', FRA: 'FR', GAB: 'GA', GBR: 'GB',
  GRD: 'GD', GEO: 'GE', GUF: 'GF', GGY: 'GG', GHA: 'GH', GIB: 'GI', GRL: 'GL',
  GMB: 'GM', GIN: 'GN', GLP: 'GP', GNQ: 'GQ', GRC: 'GR', SGS: 'GS', GTM: 'GT',
  GUM: 'GU', GNB: 'GW', GUY: 'GY', HKG: 'HK', HMD: 'HM', HND: 'HN', HRV: 'HR',
  HTI: 'HT', HUN: 'HU', IDN: 'ID', IRL: 'IE', ISR: 'IL', IMN: 'IM', IND: 'IN',
  IOT: 'IO', IRQ: 'IQ', IRN: 'IR', ISL: 'IS', ITA: 'IT', JEY: 'JE', JAM: 'JM',
  JOR: 'JO', JPN: 'JP', KEN: 'KE', KGZ: 'KG', KHM: 'KH', KIR: 'KI', COM: 'KM',
  KNA: 'KN', PRK: 'KP', KOR: 'KR', KWT: 'KW', CYM: 'KY', KAZ: 'KZ', LAO: 'LA',
  LBN: 'LB', LCA: 'LC', LIE: 'LI', LKA: 'LK', LBR: 'LR', LSO: 'LS', LTU: 'LT',
  LUX: 'LU', LVA: 'LV', LBY: 'LY', MAR: 'MA', MCO: 'MC', MDA: 'MD', MNE: 'ME',
  MAF: 'MF', MDG: 'MG', MHL: 'MH', MKD: 'MK', MLI: 'ML', MMR: 'MM', MNG: 'MN',
  MAC: 'MO', MNP: 'MP', MTQ: 'MQ', MRT: 'MR', MSR: 'MS', MLT: 'MT', MUS: 'MU',
  MDV: 'MV', MWI: 'MW', MEX: 'MX', MYS: 'MY', MOZ: 'MZ', NAM: 'NA', NCL: 'NC',
  NER: 'NE', NFK: 'NF', NGA: 'NG', NIC: 'NI', NLD: 'NL', NOR: 'NO', NPL: 'NP',
  NRU: 'NR', NIU: 'NU', NZL: 'NZ', OMN: 'OM', PAN: 'PA', PER: 'PE', PYF: 'PF',
  PNG: 'PG', PHL: 'PH', PAK: 'PK', POL: 'PL', SPM: 'PM', PCN: 'PN', PRI: 'PR',
  PSE: 'PS', PRT: 'PT', PLW: 'PW', PRY: 'PY', QAT: 'QA', REU: 'RE', ROU: 'RO',
  SRB: 'RS', RUS: 'RU', RWA: 'RW', SAU: 'SA', SLB: 'SB', SYC: 'SC', SDN: 'SD',
  SWE: 'SE', SGP: 'SG', SHN: 'SH', SVN: 'SI', SJM: 'SJ', SVK: 'SK', SLE: 'SL',
  SMR: 'SM', SEN: 'SN', SOM: 'SO', SUR: 'SR', SSD: 'SS', STP: 'ST', SLV: 'SV',
  SXM: 'SX', SYR: 'SY', SWZ: 'SZ', TCA: 'TC', TCD: 'TD', ATF: 'TF', TGO: 'TG',
  THA: 'TH', TJK: 'TJ', TKL: 'TK', TLS: 'TL', TKM: 'TM', TUN: 'TN', TON: 'TO',
  TUR: 'TR', TTO: 'TT', TUV: 'TV', TWN: 'TW', TZA: 'TZ', UKR: 'UA', UGA: 'UG',
  UMI: 'UM', USA: 'US', URY: 'UY', UZB: 'UZ', VAT: 'VA', VCT: 'VC', VEN: 'VE',
  VGB: 'VG', VIR: 'VI', VNM: 'VN', VUT: 'VU', WLF: 'WF', WSM: 'WS', YEM: 'YE',
  MYT: 'YT', ZAF: 'ZA', ZMB: 'ZM', ZWE: 'ZW',
};

/**
 * 国家码归一：2 位字母原样大写返回；3 位字母查表转 2 位；查不到/非法格式返回 null。
 * 纯函数、无副作用，供 schema transform 与其它需要归一国家码的地方复用。
 */
export function normalizeCountryCode(raw: string): string | null {
  const upper = raw.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  if (/^[A-Z]{3}$/.test(upper)) return COUNTRY_ALPHA3_TO_ALPHA2[upper] ?? null;
  return null;
}

/** raw 是否为「格式合法（3 位字母）但查不到映射」的国家码——用于区分「格式错」与「未知码」两类报错文案。 */
export function isUnmappedThreeLetterCountryCode(raw: string): boolean {
  const upper = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(upper) && !(upper in COUNTRY_ALPHA3_TO_ALPHA2);
}
