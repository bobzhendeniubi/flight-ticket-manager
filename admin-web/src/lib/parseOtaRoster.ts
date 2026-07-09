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
 *  • 航段首行：航班号必到；航段 origin-dest 可用 - / 或 → 分隔（DAD-MFM / DAD/MFM / DAD→MFM），可缺省；
 *    日期可 YYYY-MM-DD / YYYY/M/D / YYYY.M.D / YYYY年M月D日。三者顺序可小变。
 *  • 乘客段起始键：乘机人 / 乘客 / 旅客 / 姓名 均可；姓名 LAST/FIRST（含「/」）拆 lastName/firstName。
 *  • 字段键别名：性别|gender；出生年月|出生日期|生日|dob；护照|护照号|证件号|passport；
 *    签发国|发照国|国籍|nationality；有效期|护照有效期|expiry。字段行顺序可任意。
 *  • 性别：男/M/male→M，女/F/female→F。国家：中国/CHN/CHINA/CN→CN；其余 2 位字母码原样大写。
 *  • 结算价行：结算价1000元X10个 / 结算价：1000 / 1000元x10 均可；价取整数，个数（X10 个）用于人数核对。
 *  • 解析失败绝不静默丢人：每段/每字段问题写入 warnings（含「第 N 位乘客(姓名)」定位），
 *    不完整的乘客仍会返回（供前端表格里人工补全）。
 *
 * ── 手测用例（可对照本函数输出）─────────────────────────────────────────────
 *  1) 顶部样例 → flight={QH9588,DAD,MFM,2026-08-15}，2+ 位乘客带性别/生日/护照/签发国/有效期，
 *     settlementUnitPriceCny=1000，settlementCount=10。
 *  2) 全角冒号 + 多空格「性别：　男」→ 仍解析 gender=M。
 *  3) 缺护照的一段 → 该乘客仍返回，warnings 含「第 N 位乘客(...) 缺少护照号」。
 *  4) settlementCount 与乘客数不一致 → warnings 含「结算价标注 X 个与解析出的 Y 位乘客不一致」。
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

/** 解析过程中给乘客临时打的「字段无法解析」标记（finalize 时消费成 warnings，不外泄到结果类型）。 */
type WorkPassenger = ParsedOtaPassenger & {
  __genderBad?: boolean;
  __dobBad?: string | true;
  __issueCountryBad?: string | true;
  __expiryBad?: string | true;
};

/** 全角冒号/逗号 → 半角，折叠多空格；不改内容语义。 */
function normalize(line: string): string {
  return line
    .replace(/：/g, ':')
    .replace(/　/g, ' ') // 全角空格
    .replace(/\s+/g, ' ')
    .trim();
}

/** 宽容日期解析 → YYYY-MM-DD；非法返回 null。 */
export function parseLooseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 性别 → M/F；无法识别返回 null。 */
function parseGender(raw: string): 'M' | 'F' | null {
  const v = raw.trim().toLowerCase();
  if (v === '男' || v === 'm' || v === 'male') return 'M';
  if (v === '女' || v === 'f' || v === 'female') return 'F';
  return null;
}

/** 国家 → 2 位码（当前仅归一中国；其余 2 位字母原样大写）；无法归一返回 null。 */
function parseCountry(raw: string): string | null {
  const v = raw.trim().toUpperCase();
  if (!v) return null;
  if (v === '中国' || v === 'CN' || v === 'CHN' || v === 'CHINA') return 'CN';
  if (/^[A-Z]{2}$/.test(v)) return v;
  return null;
}

/** 段起始键（乘客名）。注：不能用 \b —— 中文字符非 \w，「乘机人:」间无词边界。 */
const NAME_KEY = /^(乘机人|乘客|旅客|姓名|name)\s*:?/i;

/** 首行航段：抽航班号 / 航段 / 日期（各自可缺，缺则不写并在调用处 warn）。 */
function parseFlightLine(line: string): ParsedOtaFlight | undefined {
  const s = normalize(line);
  // 航班号：2 位字母/数字承运码 + 2~4 位数字（QH9588 / 3U8888 / MF123）。
  const fn = s.match(/\b([A-Z0-9]{2}\d{2,4})\b/i);
  const route = s.match(/\b([A-Z]{3})\s*[-/→>]\s*([A-Z]{3})\b/i);
  const dateMatch = s.match(/(\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?)/);
  if (!fn && !route && !dateMatch) return undefined;
  const flight: ParsedOtaFlight = { flightNumber: fn ? fn[1].toUpperCase() : '' };
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

/** 把一段字段行灌进乘客对象；未识别字段忽略（不报错，避免误伤自由文本）。 */
function applyField(px: WorkPassenger, key: string, value: string): void {
  const k = key.trim().toLowerCase();
  if (/性别|gender/.test(k)) {
    const g = parseGender(value);
    if (g) px.gender = g;
    else px.__genderBad = true;
  } else if (/出生年月|出生日期|生日|dob|birth/.test(k)) {
    const d = parseLooseDate(value);
    if (d) px.dateOfBirth = d;
    else px.__dobBad = value.trim() || true;
  } else if (/护照|证件|passport|doc/.test(k)) {
    px.documentNumber = value.replace(/\s+/g, '').trim() || undefined;
  } else if (/签发国|发照国|passportissue|issue/.test(k)) {
    const c = parseCountry(value);
    if (c) px.passportIssueCountry = c;
    else px.__issueCountryBad = value.trim() || true;
  } else if (/国籍|nationality/.test(k)) {
    const c = parseCountry(value);
    if (c) px.nationality = c;
  } else if (/有效期|expiry|expire/.test(k)) {
    const d = parseLooseDate(value);
    if (d) px.passportExpiry = d;
    else px.__expiryBad = value.trim() || true;
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

    // 乘客段起始（姓名键）
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

    // 字段行（key:value）——仅在已进入某乘客段时消费
    const colon = line.indexOf(':');
    if (current && colon > 0) {
      applyField(current, line.slice(0, colon), line.slice(colon + 1));
      continue;
    }

    // 尚未进入乘客段的非字段行 → 尝试当作航段首行（只认第一条）
    if (!current && !flight) {
      const f = parseFlightLine(line);
      if (f) {
        flight = f;
        continue;
      }
    }
    // 其余无法归类的行：像字段却没归属则提示（正文噪声不提示）
    if (!current && colon > 0) {
      warnings.push(`忽略未归属到乘客的字段行：「${raw}」`);
    }
  }
  pushCurrent();

  // 航段校验
  if (!flight) {
    warnings.push('未能识别首行航段（航班号/航段/日期），请手动选择航班与班次');
  } else {
    if (!flight.flightNumber) warnings.push('未能识别航班号（首行），请手动选择航班');
    if (!flight.departDate) warnings.push('未能识别航班日期（首行），请手动选择起飞日期/班次');
  }

  // 逐段字段校验（定位到「第 N 位乘客(姓名)」），并清除临时标记
  passengers.forEach((px, idx) => {
    const who = `第 ${idx + 1} 位乘客(${px.fullName || '未命名'})`;
    if (!px.fullName.trim()) warnings.push(`${who} 缺少姓名`);
    if (!px.documentNumber) warnings.push(`${who} 缺少护照号`);
    if (!px.dateOfBirth) {
      if (px.__dobBad) warnings.push(`${who} 出生日期无法解析：「${px.__dobBad === true ? '' : px.__dobBad}」`);
      else warnings.push(`${who} 缺少出生日期`);
    }
    if (px.__genderBad) warnings.push(`${who} 性别无法识别（需 男/女）`);
    if (px.__issueCountryBad) {
      warnings.push(`${who} 签发国无法识别为国家码：「${px.__issueCountryBad === true ? '' : px.__issueCountryBad}」`);
    }
    if (px.__expiryBad) warnings.push(`${who} 有效期无法解析：「${px.__expiryBad === true ? '' : px.__expiryBad}」`);
    delete px.__genderBad;
    delete px.__dobBad;
    delete px.__issueCountryBad;
    delete px.__expiryBad;
  });

  if (passengers.length === 0) {
    warnings.push('未解析出任何乘客（乘客段以「乘机人 / 乘客 / 旅客 / 姓名」起始）');
  }

  // 人数核对
  if (settlementCount !== undefined && settlementCount !== passengers.length) {
    warnings.push(`结算价标注 ${settlementCount} 个与解析出的 ${passengers.length} 位乘客不一致，请核对名单`);
  }

  return { flight, passengers, settlementUnitPriceCny, settlementCount, warnings };
}
