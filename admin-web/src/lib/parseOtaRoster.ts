/**
 * parseOtaRoster —— OTA 线上单名单「粘贴文本 → 结构化」纯函数（无副作用、无网络/DOM）。
 *
 * 运营从 OTA 后台/收单群复制的名单，格式大致如下（首行航段，随后若干乘客段，末行结算价）：
 *
 *   QH9588 DAD-MFM 2026-08-15
 *   乘机人：WU/FEILAI
 *   性别：男
 *   出生年月：1983-09-20
 *   护照：EB9452866
 *   签发国：CN
 *   有效期：2028-01-02
 *   乘机人：WANG/LIQING
 *   性别：女
 *   ...
 *   结算价1000元X10个。
 *
 * ── 支持的格式变体（宽容解析）───────────────────────────────────────────────
 *  • 冒号：全角「：」/ 半角「:」/ 前后多空格 均可（性别： 男 / 护照:EB9452866）。
 *  • 航段首行：航班号必到；航段 origin-dest 可用 - / 或 → 分隔（DAD-MFM / DAD/MFM / DAD→MFM），也可空格分隔
 *    （QH9588 DAD MFM 2026-7-17，见「格式一」）；可缺省；
 *    日期可 YYYY-MM-DD / YYYY/M/D / YYYY.M.D / YYYY年M月D日，或 DD-MM-YYYY / DD/MM/YYYY（日在前，见下）。
 *  • 乘客段起始键：乘机人 / 乘客 / 旅客 / 姓名 均可；姓名 LAST/FIRST（含「/」）拆 lastName/firstName。
 *  • 字段键别名：性别|gender；出生年月|出生日期|生日|dob；护照|护照号|证件号|passport；
 *    签发国|发照国|国籍|nationality；有效期|护照有效期|expiry。字段行顺序可任意。
 *  • 性别：男/M/male→M，女/F/female→F。
 *  • 国家：中国/中国大陆/CHN/CHINA/CN→CN；2 位字母码原样大写；3 位字母码查表归一（MAC→MO、HKG→HK、
 *    TWN→TW、SGP→SG、MYS→MY、KOR→KR、JPN→JP、VNM→VN、USA→US 等），查不到的 3 位码原样保留并 warning 提示核对。
 *  • 日期歧义：DD-MM-YYYY / DD/MM/YYYY——日>12 可确定日在前（如 31-01-1996）；日≤12 时按「日-月-年」处理，
 *    并追加提示性 warning（如 05-06-1990 可能是 5 月 6 日或 6 月 5 日，已按日在前解析，请核对）。
 *  • 结算价行：结算价1000元X10个 / 结算价：1000 / 1000元x10 均可；价取整数，个数（X10 个）用于人数核对。
 *    未识别到结算价（全篇无「结算价」关键字也无可用价格行）时，不静默丢弃——追加 warning 提示可手动填。
 *
 * ── 格式一：单行空格分隔（无冒号、无「乘机人」前缀）─────────────────────────
 *   示例：
 *     FANG/BIN 男 普通 护照 EM9441432 中国大陆  1983-11-25 2034-7-8
 *     QH9588 DAD MFM 2026-7-17
 *     1070
 *     单独编码
 *  • 乘客行识别特征（三者都命中才算乘客行，避免误伤航段/编码行）：
 *    以「姓/名」（含斜杠的拉丁姓名）开头 + 行内含性别 token（男/女/M/F）+ 含证件号 token（字母+数字混合、长度≥6）。
 *    证件类型词（普通/护照等）忽略；国籍取剩余 token 中第一个能识别为国家的；两个日期按「生日≤今年<有效期」的
 *    合理性顺序分配为出生日期/有效期（判断不出合理顺序时保留原书写顺序）。
 *  • 航段行放宽：航班号 + 两个 3 位大写机场码 + 日期，允许纯空格分隔（无需 - 分隔符）；先跑严格分支（原有
 *    DAD-MFM 语法），结果不全时用宽松分支（空格分隔）补全缺失字段，避免宽松分支误伤/覆盖严格分支已识别的航段。
 *    乘客行的判定发生在航段解析之前——命中乘客行特征就不再尝试当航段解析，避免把生日误当航班日期。
 *  • 裸数字行（100–99999 范围、整行只有数字）：在已有乘客或航段上下文时按结算价识别，并 warning 提示核对。
 *  • 订座编码行（共用编码轻方案）：含「编码」字样的行（单独编码 / XXXXXX编码 / 编码：ABC123）或独占一行的
 *    5~6 位字母+数字（须同时含字母与数字，避免跟纯数字价格行/纯字母噪声混淆）——识别为订座编码，写入解析结果
 *    **每位乘客**的备注（note），供批量建单页面回填到该乘客的个别备注。多位乘客共用同一段航班/价格/编码时可
 *    正确共享。
 *
 * ── 解析失败绝不静默丢人 ─────────────────────────────────────────────────
 *  每段/每字段问题写入 warnings（含「第 N 位乘客(姓名)」定位），不完整的乘客仍会返回（供前端表格里人工补全）。
 *
 * ── 手测用例（可对照本函数输出）─────────────────────────────────────────────
 *  1) 顶部样例 → flight={QH9588,DAD,MFM,2026-08-15}，2+ 位乘客带性别/生日/护照/签发国/有效期，
 *     settlementUnitPriceCny=1000，settlementCount=10。
 *  2) 全角冒号 + 多空格「性别：　男」→ 仍解析 gender=M。
 *  3) 缺护照的一段 → 该乘客仍返回，warnings 含「第 N 位乘客(...) 缺少护照号」。
 *  4) settlementCount 与乘客数不一致 → warnings 含「结算价标注 X 个与解析出的 Y 位乘客不一致」。
 *  5) 格式一样例（见上）→ 1 位乘客 FANG/BIN，gender=M，documentNumber=EM9441432，nationality=CN，
 *     dateOfBirth=1983-11-25，passportExpiry=2034-07-08；flight={QH9588,DAD,MFM,2026-07-17}；
 *     settlementUnitPriceCny=1070（按裸价格行识别，warning 提示核对）；note 含「单独编码」。
 *  6) 「签发国：MAC」→ passportIssueCountry=MO（3 位码归一，无 warning）；「签发国：ZZZ」→ 原样保留 ZZZ 且
 *     warning 提示核对；「有效期：31-01-1996」→ passportExpiry=1996-01-31（日>12 无歧义）。
 *  7) 全篇无「结算价」关键字也无价格行 → settlementUnitPriceCny=undefined，warnings 含「未识别到结算价」提示。
 */

export interface ParsedOtaFlight {
  flightNumber: string;
  origin?: string;
  destination?: string;
  /** YYYY-MM-DD */
  departDate?: string;
}

export interface ParsedOtaPassenger {
  /** 原始姓名串（如 WU/FEILAI）；用于 fullName。 */
  fullName: string;
  lastName?: string;
  firstName?: string;
  gender?: 'M' | 'F';
  /** YYYY-MM-DD */
  dateOfBirth?: string;
  documentNumber?: string;
  /** 2 位国家码（如 CN） */
  nationality?: string;
  /** 2 位国家码（如 CN） */
  passportIssueCountry?: string;
  /** YYYY-MM-DD */
  passportExpiry?: string;
  /** 附加信息（如识别到的订座编码行），前端回填到该乘客的个别备注；未识别到则不设。 */
  note?: string;
  /** 订座编码（PNR）：全篇恰好识别到一个编码 token 时全员同值（一码多人）；多个/没有则不设。 */
  pnr?: string;
}

export interface OtaRosterParseResult {
  flight?: ParsedOtaFlight;
  passengers: ParsedOtaPassenger[];
  /** 结算价（整数 CNY / 人） */
  settlementUnitPriceCny?: number;
  /** 名单标注的人数（「X10 个」中的 10），用于与乘客数核对 */
  settlementCount?: number;
  /** 解析提醒（定位到段 / 字段），前端原样展示；绝不静默丢人。 */
  warnings: string[];
}

/** 解析过程中给乘客临时打的「字段无法解析/需要核对」标记（finalize 时消费成 warnings，不外泄到结果类型）。 */
type WorkPassenger = ParsedOtaPassenger & {
  __genderBad?: boolean;
  __dobBad?: string | true;
  __dobAmbiguous?: string;
  __issueCountryBad?: string | true;
  __issueCountryUnmapped?: string;
  __nationalityUnmapped?: string;
  __expiryBad?: string | true;
  __expiryAmbiguous?: string;
};

/** 全角冒号/逗号 → 半角，折叠多空格；不改内容语义。 */
function normalize(line: string): string {
  return line
    .replace(/：/g, ':')
    .replace(/　/g, ' ') // 全角空格
    .replace(/\s+/g, ' ')
    .trim();
}

/** 年月日三段校验 + 转 ISO；非法返回 null。 */
function toIsoIfValid(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 宽容日期解析 → YYYY-MM-DD；非法返回 null。
 * 支持年在前（YYYY-M-D / YYYY年M月D日）与日在前（DD-MM-YYYY / DD/MM/YYYY，见 isAmbiguousDayFirstDate）两类。
 */
export function parseLooseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  // 年在前：YYYY-MM-DD / YYYY/M/D / YYYY.M.D / YYYY年M月D日
  const m = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
  if (m) {
    return toIsoIfValid(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  // 日在前：DD-MM-YYYY / DD/MM/YYYY——日>12 可确定日在前；日≤12 时按「日-月-年」处理（歧义见 isAmbiguousDayFirstDate）。
  const m2 = s.match(/^(\d{1,2})\s*[-/]\s*(\d{1,2})\s*[-/]\s*(\d{4})$/);
  if (m2) {
    const first = Number(m2[1]);
    const second = Number(m2[2]);
    const year = Number(m2[3]);
    if (first > 12) return toIsoIfValid(year, second, first);
    if (second <= 12) return toIsoIfValid(year, second, first);
    return null; // second>12 时无法构成合法「日-月-年」
  }
  return null;
}

/** raw 是否命中「日≤12 的 DD-MM-YYYY 歧义」分支——已按日在前解析，仅供上层追加「请核对」提示，不影响解析结果本身。 */
function isAmbiguousDayFirstDate(raw: string): boolean {
  const s = raw.trim();
  if (/^\d{4}\s*[-/.年]/.test(s)) return false; // 年在前不歧义
  const m2 = s.match(/^(\d{1,2})\s*[-/]\s*(\d{1,2})\s*[-/]\s*(\d{4})$/);
  if (!m2) return false;
  const first = Number(m2[1]);
  const second = Number(m2[2]);
  return first <= 12 && second <= 12 && first !== second;
}

/** 性别 → M/F；无法识别返回 null。 */
function parseGender(raw: string): 'M' | 'F' | null {
  const v = raw.trim().toLowerCase();
  if (v === '男' || v === 'm' || v === 'male') return 'M';
  if (v === '女' || v === 'f' || v === 'female') return 'F';
  return null;
}

/**
 * 3 位国家/地区码 → 2 位 ISO，ISO 3166-1 标准全集（与 backend/src/lib/country-codes.ts
 * 的 COUNTRY_ALPHA3_TO_ALPHA2 保持数据口径一致——两端各自维护一份，前后端无共享 TS 包基建，
 * 重复一份小表比引入跨项目依赖更简单）。0720 反馈：此前只有 16 条常见码，表外 3 位码
 * （如护照 MRZ 常见的多数国家码）原样透传到后端，被 nationality: z.string().length(2) 拒绝，
 * 整批建单 400。
 */
const COUNTRY_3TO2: Record<string, string> = {
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
 * 中文国家/地区名 → 2 位 ISO 码（覆盖出行常见国家地区；中国大陆本身在 parseCountry 里
 * 单独处理，不放这里）。0720 反馈：此前「越南」等非「中国」的中文国名一律 parseCountry
 * 返回 null，前端提交时静默回落成 'CN'，外籍乘客国籍被写错且没有 warning 提示。
 */
const COUNTRY_CN_NAME_TO_2: Record<string, string> = {
  '中国香港': 'HK', '香港': 'HK',
  '中国澳门': 'MO', '澳门': 'MO',
  '中国台湾': 'TW', '台湾': 'TW',
  '越南': 'VN',
  '日本': 'JP',
  '韩国': 'KR', '南韩': 'KR', '大韩民国': 'KR',
  '朝鲜': 'KP', '北韩': 'KP',
  '泰国': 'TH',
  '新加坡': 'SG',
  '马来西亚': 'MY',
  '菲律宾': 'PH',
  '印尼': 'ID', '印度尼西亚': 'ID',
  '柬埔寨': 'KH',
  '老挝': 'LA',
  '缅甸': 'MM',
  '美国': 'US',
  '英国': 'GB',
  '加拿大': 'CA',
  '澳大利亚': 'AU', '澳洲': 'AU',
  '俄罗斯': 'RU', '俄国': 'RU',
  '印度': 'IN',
  '德国': 'DE',
  '法国': 'FR',
  '意大利': 'IT',
  '西班牙': 'ES',
  '荷兰': 'NL',
  '瑞士': 'CH',
  '新西兰': 'NZ',
  '土耳其': 'TR',
};

/**
 * 国家 → 2 位码：中国别名（中国/中国大陆/CHN/CHINA）→ CN；常见中文国名（越南/日本/…）查表；
 * 2 位字母码原样大写；3 位字母码查表归一，查不到时原样保留（调用方用
 * isUnmappedThreeLetterCountry 判断是否需要 warning 提示核对）。
 * 无法识别（非 2/3 位字母、非中国别名、非已知中文国名）返回 null。
 */
function parseCountry(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^中国(大陆)?(地区)?$/.test(v)) return 'CN';
  if (v in COUNTRY_CN_NAME_TO_2) return COUNTRY_CN_NAME_TO_2[v];
  const upper = v.toUpperCase();
  if (upper === 'CN' || upper === 'CHN' || upper === 'CHINA') return 'CN';
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  if (/^[A-Z]{3}$/.test(upper)) return COUNTRY_3TO2[upper] ?? upper;
  return null;
}

/** raw 是否为「查不到映射、原样保留」的 3 位码——非解析失败，仅提示核对。 */
function isUnmappedThreeLetterCountry(raw: string): boolean {
  const upper = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(upper) && !(upper in COUNTRY_3TO2) && upper !== 'CHN';
}

/** 段起始键（乘客名）。注：不能用 \b —— 中文字符非 \w，「乘机人:」间无词边界。 */
const NAME_KEY = /^(乘机人|乘客|旅客|姓名|name)\s*:?/i;

/** 首行航段（严格分支）：抽航班号 / 航段（- / → > 分隔）/ 日期（各自可缺，缺则不写并在调用处 warn）。 */
function parseFlightLine(line: string): ParsedOtaFlight | undefined {
  const s = normalize(line);
  // 航班号：2 位字母/数字承运码 + 2~4 位数字（QH9588 / 3U8888 / MF123）；须含至少 1 位字母，
  // 避免纯数字（如裸价格行「1070」）被误判为航班号。
  const fnMatch = s.match(/\b([A-Z0-9]{2}\d{2,4})\b/i);
  const fn = fnMatch && /[A-Z]/i.test(fnMatch[1]) ? fnMatch[1] : undefined;
  const route = s.match(/\b([A-Z]{3})\s*[-/→>]\s*([A-Z]{3})\b/i);
  const dateMatch = s.match(/(\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?)/);
  if (!fn && !route && !dateMatch) return undefined;
  const flight: ParsedOtaFlight = { flightNumber: fn ? fn.toUpperCase() : '' };
  if (route) {
    flight.origin = route[1].toUpperCase();
    flight.destination = route[2].toUpperCase();
  }
  if (dateMatch) {
    const iso = parseLooseDate(dateMatch[1]);
    if (iso) flight.departDate = iso;
  }
  return flight;
}

/**
 * 首行航段（格式一宽松分支）：空格分隔、无 - 分隔符，如「QH9588 DAD MFM 2026-7-17」。
 * 要求命中航班号 token，且（两个 3 位机场码 token 或一个可解析日期 token）之一，避免噪声行被误判。
 */
function parseLooseFlightLine(line: string): ParsedOtaFlight | undefined {
  const tokens = line.split(' ').map((t) => t.trim()).filter(Boolean);
  if (tokens.length < 2) return undefined;
  const fnToken = tokens.find((t) => /^[A-Z0-9]{2}\d{2,4}$/i.test(t) && /[A-Z]/i.test(t));
  if (!fnToken) return undefined;
  const airportTokens = tokens.filter((t) => /^[A-Z]{3}$/i.test(t));
  const dateToken = tokens.find((t) => parseLooseDate(t) !== null);
  if (airportTokens.length < 2 && !dateToken) return undefined;
  const flight: ParsedOtaFlight = { flightNumber: fnToken.toUpperCase() };
  if (airportTokens.length >= 2) {
    flight.origin = airportTokens[0].toUpperCase();
    flight.destination = airportTokens[1].toUpperCase();
  }
  if (dateToken) {
    const iso = parseLooseDate(dateToken);
    if (iso) flight.departDate = iso;
  }
  return flight;
}

/**
 * 首行航段：先跑严格分支（- / → > 分隔），再跑宽松分支（空格分隔），两者取并集补全缺失字段——
 * 严格分支已识别到的字段优先保留，宽松分支只补严格分支没识别到的（如严格分支识别到航班号+日期但
 * 因用空格分隔而抓不到航段时，宽松分支补上 origin/destination）。都识别不到才返回 undefined。
 */
function parseAnyFlightLine(line: string): ParsedOtaFlight | undefined {
  const strict = parseFlightLine(line);
  const loose = parseLooseFlightLine(line);
  if (!strict && !loose) return undefined;
  return {
    flightNumber: strict?.flightNumber || loose?.flightNumber || '',
    origin: strict?.origin ?? loose?.origin,
    destination: strict?.destination ?? loose?.destination,
    departDate: strict?.departDate ?? loose?.departDate,
  };
}

/** 结算价行：结算价1000元X10个 → { price:1000, count:10 }。 */
function parseSettlement(line: string): { price?: number; count?: number } {
  const s = normalize(line);
  const priceMatch = s.match(/结算价[^\d]*([\d,]+)/);
  const countMatch = s.match(/[X×*x]\s*(\d+)\s*个?/) || s.match(/(\d+)\s*个/);
  const out: { price?: number; count?: number } = {};
  if (priceMatch) {
    const n = Number(priceMatch[1].replace(/,/g, ''));
    if (Number.isFinite(n)) out.price = Math.round(n);
  }
  if (countMatch) {
    const n = Number(countMatch[1]);
    if (Number.isFinite(n)) out.count = n;
  }
  return out;
}

/** 裸数字行（格式一价格行）：整行只有 3~6 位数字、取值在 [100, 99999] 才算价格；否则返回 null。 */
function parseBarePriceLine(line: string): number | null {
  const s = line.trim();
  if (!/^\d{3,6}$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 100 || n > 99999) return null;
  return n;
}

/**
 * 订座编码行（共用编码轻方案）：含「编码」字样的整行原样返回作为提示文本；
 * 或整行独占的 5~6 位字母+数字混合 token（须同时含字母与数字，避免跟纯数字价格行/纯字母噪声混淆）。
 * 均不命中返回 null。
 */
function detectBookingCodeNote(line: string): string | null {
  const s = line.trim();
  if (!s) return null;
  if (/编码/.test(s)) return s;
  if (/^[A-Za-z0-9]{5,6}$/.test(s) && /[A-Za-z]/.test(s) && /\d/.test(s)) {
    return `编码：${s.toUpperCase()}`;
  }
  return null;
}

/** 把两个日期按「生日 ≤ 今年 < 有效期」的合理性分配为 dob/expiry；判断不出合理顺序时保留原书写顺序。 */
function assignDobAndExpiry(dates: string[]): { dob?: string; expiry?: string } {
  if (dates.length === 0) return {};
  const currentYear = new Date().getFullYear();
  if (dates.length === 1) {
    const y = Number(dates[0].slice(0, 4));
    return y <= currentYear ? { dob: dates[0] } : { expiry: dates[0] };
  }
  const [a, b] = dates;
  const ya = Number(a.slice(0, 4));
  const yb = Number(b.slice(0, 4));
  if (ya <= currentYear && yb > ya) return { dob: a, expiry: b };
  if (yb <= currentYear && ya > yb) return { dob: b, expiry: a };
  return { dob: a, expiry: b };
}

/**
 * 格式一：单行空格分隔乘客行，如「FANG/BIN 男 普通 护照 EM9441432 中国大陆 1983-11-25 2034-7-8」。
 * 识别特征（三者都命中才当乘客行处理，避免误伤航段/编码行、避免生日被误当航班日期）：
 *   以「姓/名」开头 + 含性别 token + 含证件号 token（字母+数字混合、长度≥6）。
 * 不满足特征一律返回 null（交由其它分支处理，绝不强行拆字段）。
 */
function parseLoosePassengerLine(line: string): WorkPassenger | null {
  const nameMatch = line.match(/^([A-Za-z]+)\/([A-Za-z]+)\b\s*(.*)$/);
  if (!nameMatch) return null;
  const [, last, first, restRaw] = nameMatch;
  const tokens = restRaw.split(' ').map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return null;

  const genderToken = tokens.find((t) => parseGender(t) !== null);
  if (!genderToken) return null;

  const docToken = tokens.find((t) => /^[A-Za-z0-9]{6,}$/.test(t) && /[A-Za-z]/.test(t) && /\d/.test(t));
  if (!docToken) return null;

  const px: WorkPassenger = { fullName: `${last}/${first}`, lastName: last, firstName: first };
  const g = parseGender(genderToken);
  if (g) px.gender = g;
  px.documentNumber = docToken.toUpperCase();

  // 国籍：证件类型词（普通/护照等）与已消费 token 之外，第一个能被 parseCountry 识别的 token。
  const consumed = new Set([genderToken, docToken]);
  const countryToken = tokens.find((t) => !consumed.has(t) && parseCountry(t) !== null);
  if (countryToken) {
    const c = parseCountry(countryToken) as string;
    px.nationality = c;
    if (isUnmappedThreeLetterCountry(countryToken)) px.__nationalityUnmapped = c;
    consumed.add(countryToken);
  }

  // 日期：其余 token 中能被 parseLooseDate 解析的，按出现顺序取前两个，再按合理性分配生日/有效期。
  const dateTokens = tokens.filter((t) => !consumed.has(t) && parseLooseDate(t) !== null).slice(0, 2);
  const dates = dateTokens.map((t) => parseLooseDate(t) as string);
  const { dob, expiry } = assignDobAndExpiry(dates);
  if (dob) {
    px.dateOfBirth = dob;
    const rawTok = dateTokens[dates.indexOf(dob)];
    if (rawTok && isAmbiguousDayFirstDate(rawTok)) px.__dobAmbiguous = rawTok;
  }
  if (expiry) {
    px.passportExpiry = expiry;
    const rawTok = dateTokens[dates.indexOf(expiry)];
    if (rawTok && isAmbiguousDayFirstDate(rawTok)) px.__expiryAmbiguous = rawTok;
  }

  return px;
}

/** 把一段字段行灌进乘客对象；未识别字段忽略（不报错，避免误伤自由文本）。 */
function applyField(px: WorkPassenger, key: string, value: string): void {
  const k = key.trim().toLowerCase();
  if (/性别|gender/.test(k)) {
    const g = parseGender(value);
    if (g) px.gender = g;
    else px.__genderBad = true;
  } else if (/出生年月|出生日期|生日|dob|birth/.test(k)) {
    const d = parseLooseDate(value);
    if (d) {
      px.dateOfBirth = d;
      if (isAmbiguousDayFirstDate(value)) px.__dobAmbiguous = value.trim();
    } else px.__dobBad = value.trim() || true;
  } else if (/护照|证件|passport|doc/.test(k)) {
    px.documentNumber = value.replace(/\s+/g, '').trim() || undefined;
  } else if (/签发国|发照国|passportissue|issue/.test(k)) {
    const c = parseCountry(value);
    if (c) {
      px.passportIssueCountry = c;
      if (isUnmappedThreeLetterCountry(value)) px.__issueCountryUnmapped = c;
    } else px.__issueCountryBad = value.trim() || true;
  } else if (/国籍|nationality/.test(k)) {
    const c = parseCountry(value);
    if (c) {
      px.nationality = c;
      if (isUnmappedThreeLetterCountry(value)) px.__nationalityUnmapped = c;
    }
  } else if (/有效期|expiry|expire/.test(k)) {
    const d = parseLooseDate(value);
    if (d) {
      px.passportExpiry = d;
      if (isAmbiguousDayFirstDate(value)) px.__expiryAmbiguous = value.trim();
    } else px.__expiryBad = value.trim() || true;
  }
}

export function parseOtaRoster(text: string): OtaRosterParseResult {
  const warnings: string[] = [];
  const rawLines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (rawLines.length === 0) {
    return { passengers: [], warnings: ['粘贴内容为空'] };
  }

  let flight: ParsedOtaFlight | undefined;
  let settlementUnitPriceCny: number | undefined;
  let settlementCount: number | undefined;
  const passengers: WorkPassenger[] = [];
  const bookingCodeNotes: string[] = [];
  let current: WorkPassenger | null = null;

  const pushCurrent = (): void => {
    if (current) passengers.push(current);
    current = null;
  };

  for (const raw of rawLines) {
    const line = normalize(raw);

    // 结算价行（可能出现在任意位置，通常末行）
    if (/结算价/.test(line)) {
      const st = parseSettlement(line);
      if (st.price !== undefined) settlementUnitPriceCny = st.price;
      if (st.count !== undefined) settlementCount = st.count;
      continue;
    }

    // 订座编码行（共用编码轻方案）：含「编码」字样，或独占一行的 5~6 位字母+数字 token。
    const codeNote = detectBookingCodeNote(line);
    if (codeNote) {
      bookingCodeNotes.push(codeNote);
      continue;
    }

    // 乘客段起始（姓名键，格式二：乘机人:/乘客:/旅客:/姓名: 前缀）
    if (NAME_KEY.test(line)) {
      pushCurrent();
      const colon = line.indexOf(':');
      const nameRaw = colon >= 0 ? line.slice(colon + 1).trim() : line.replace(NAME_KEY, '').trim();
      const px: WorkPassenger = { fullName: nameRaw };
      if (nameRaw.includes('/')) {
        const [last, ...rest] = nameRaw.split('/');
        px.lastName = last.trim() || undefined;
        px.firstName = rest.join('/').trim() || undefined;
      }
      current = px;
      continue;
    }

    // 乘客行（格式一：单行空格分隔，姓/名开头 + 性别 + 证件号 token）——命中就整行收尾，
    // 不留 current，避免挡住后续航段/价格行识别；同时保证先判乘客行特征，不会把生日误当航班日期。
    const looseP = parseLoosePassengerLine(line);
    if (looseP) {
      pushCurrent();
      passengers.push(looseP);
      continue;
    }

    // 字段行（key:value，格式二）——仅在已进入某乘客段时消费
    const colon = line.indexOf(':');
    if (current && colon > 0) {
      applyField(current, line.slice(0, colon), line.slice(colon + 1));
      continue;
    }

    // 尚未进入乘客段的非字段行 → 尝试当作航段首行（严格 + 宽松，只认第一条）
    if (!current && !flight) {
      const f = parseAnyFlightLine(line);
      if (f) {
        flight = f;
        continue;
      }
    }

    // 裸数字行（格式一价格行）：已有乘客/航段上下文时才当结算价，避免开篇噪声被误判。
    const bareNum = parseBarePriceLine(line);
    if (bareNum !== null && (current || passengers.length > 0 || flight)) {
      settlementUnitPriceCny = bareNum;
      warnings.push(`按价格行识别：¥${bareNum}，请核对`);
      continue;
    }

    // 其余无法归类的行：像字段却没归属则提示（正文噪声不提示）
    if (!current && colon > 0) {
      warnings.push(`忽略未归属到乘客的字段行：「${raw}」`);
    }
  }
  pushCurrent();

  // 订座编码 → 写入每位乘客备注（共用编码轻方案：不区分乘客，全员一致）
  if (bookingCodeNotes.length > 0) {
    const noteJoined = bookingCodeNotes.join('；');
    passengers.forEach((px) => {
      px.note = px.note ? `${px.note}；${noteJoined}` : noteJoined;
    });
    // 结构化落 PNR：全篇恰好一个编码 token（5~6 位字母+数字）→ 全员 pnr 同值（一码多人，
    // 与航司模型一致，落 Passenger.pnr 可查可导）。识别到多个编码时不猜归属，只留备注。
    const tokens = new Set<string>();
    for (const noteText of bookingCodeNotes) {
      const m = noteText.toUpperCase().match(/\b(?=[A-Z0-9]{5,6}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*[0-9])[A-Z0-9]{5,6}\b/g);
      for (const t of m ?? []) tokens.add(t);
    }
    if (tokens.size === 1) {
      const pnr = [...tokens][0]!;
      passengers.forEach((px) => {
        px.pnr = pnr;
      });
      warnings.push(`识别到订座编码「${pnr}」，已写入每位乘客的 PNR 字段（一码多人）+ 备注，请核对`);
    } else {
      warnings.push(`识别到订座编码信息「${noteJoined}」，已写入每位乘客备注，请核对`);
    }
  }

  // 航段校验
  if (!flight) {
    warnings.push('未能识别首行航段（航班号/航段/日期），请手动选择航班与班次');
  } else {
    if (!flight.flightNumber) warnings.push('未能识别航班号（首行），请手动选择航班');
    if (!flight.departDate) warnings.push('未能识别航班日期（首行），请手动选择起飞日期/班次');
  }

  // 结算价校验：全篇未识别到价格也不静默丢弃
  if (settlementUnitPriceCny === undefined) {
    warnings.push('未识别到结算价——请检查名单里是否有"结算价: XXX"或价格行；价格可在下方"OTA 结算单价"框手动填');
  }

  // 逐段字段校验（定位到「第 N 位乘客(姓名)」），并清除临时标记
  passengers.forEach((px, idx) => {
    const who = `第 ${idx + 1} 位乘客(${px.fullName || '未命名'})`;
    if (!px.fullName.trim()) warnings.push(`${who} 缺少姓名`);
    if (!px.documentNumber) warnings.push(`${who} 缺少护照号`);
    if (!px.dateOfBirth) {
      if (px.__dobBad) warnings.push(`${who} 出生日期无法解析：「${px.__dobBad === true ? '' : px.__dobBad}」`);
      else warnings.push(`${who} 缺少出生日期`);
    } else if (px.__dobAmbiguous) {
      warnings.push(`${who} 出生日期「${px.__dobAmbiguous}」为日/月歧义格式，已按「日-月-年」解析，请核对`);
    }
    if (px.__genderBad) warnings.push(`${who} 性别无法识别（需 男/女）`);
    if (px.__issueCountryBad) {
      warnings.push(`${who} 签发国无法识别为国家码：「${px.__issueCountryBad === true ? '' : px.__issueCountryBad}」`);
    }
    if (px.__issueCountryUnmapped) {
      warnings.push(`${who} 签发国码「${px.__issueCountryUnmapped}」为 3 位码且未匹配到已知映射，已按原样保留，请核对`);
    }
    if (px.__nationalityUnmapped) {
      warnings.push(`${who} 国籍码「${px.__nationalityUnmapped}」为 3 位码且未匹配到已知映射，已按原样保留，请核对`);
    }
    if (px.__expiryBad) warnings.push(`${who} 有效期无法解析：「${px.__expiryBad === true ? '' : px.__expiryBad}」`);
    else if (px.__expiryAmbiguous) {
      warnings.push(`${who} 有效期「${px.__expiryAmbiguous}」为日/月歧义格式，已按「日-月-年」解析，请核对`);
    }
    delete px.__genderBad;
    delete px.__dobBad;
    delete px.__dobAmbiguous;
    delete px.__issueCountryBad;
    delete px.__issueCountryUnmapped;
    delete px.__nationalityUnmapped;
    delete px.__expiryBad;
    delete px.__expiryAmbiguous;
  });

  if (passengers.length === 0) {
    warnings.push('未解析出任何乘客（乘客段以「乘机人 / 乘客 / 旅客 / 姓名」起始，或整行空格分隔含姓/名+性别+证件号）');
  }

  // 人数核对
  if (settlementCount !== undefined && settlementCount !== passengers.length) {
    warnings.push(`结算价标注 ${settlementCount} 个与解析出的 ${passengers.length} 位乘客不一致，请核对名单`);
  }

  return { flight, passengers, settlementUnitPriceCny, settlementCount, warnings };
}
