/**
 * TD3 护照机读区（MRZ）解析 + 校验位验证
 *
 * TD3 = 2 行 × 44 字符。用于在识别护照后对机读字段做确定性校验，
 * 提醒录单人哪些字段需要人工二次核对（护照反光等导致目视区误读时，
 * 以校验位通过的机读区取值为准）。
 *
 * 校验位算法：7-3-1 循环权重，字符值 数字=本身、A-Z=10-35、'<'=0，求和模 10。
 *
 * 容错：行长非 44 / 非法字符 → 返回 null 或 valid:false，绝不 throw。
 */

const TD3_LINE_LENGTH = 44;
const CHECK_WEIGHTS = [7, 3, 1] as const;

export interface MrzChecks {
  passportNumber: boolean;
  dateOfBirth: boolean;
  expiryDate: boolean;
  personalNumber: boolean;
  composite: boolean;
}

export interface MrzResult {
  /** 所有校验位是否全部通过 */
  valid: boolean;
  surname: string;
  givenNames: string;
  passportNumber: string;
  nationality: string;
  /** YYYY-MM-DD */
  dateOfBirth: string;
  /** M / F / X */
  sex: string;
  /** YYYY-MM-DD */
  expiryDate: string;
  checks: MrzChecks;
}

/** 单字符的 MRZ 值：数字=本身、A-Z=10-35、'<'=0，其他=null（非法）。 */
function charValue(c: string): number | null {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 55; // 'A'(65) → 10
  if (c === '<') return 0;
  return null;
}

/** 计算一段字段的校验位（0-9），遇非法字符返回 null。 */
function computeCheckDigit(field: string): number | null {
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    const v = charValue(field[i]);
    if (v === null) return null;
    sum += v * CHECK_WEIGHTS[i % 3];
  }
  return sum % 10;
}

/** 校验位字符可为数字或 '<'（填充位视作 0）。返回其数值，非法返回 null。 */
function checkCharValue(c: string): number | null {
  if (c === '<') return 0;
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  return null;
}

/** 校验一段字段与其校验位是否匹配。 */
function verifyField(field: string, checkChar: string): boolean {
  const expected = computeCheckDigit(field);
  const actual = checkCharValue(checkChar);
  if (expected === null || actual === null) return false;
  return expected === actual;
}

/**
 * YYMMDD → YYYY-MM-DD。
 * 出生日期：两位年 > 当前两位年 → 19xx，否则 20xx；若得出的日期在未来则再减 100 年。
 * 有效期：一律 20xx。
 * 非法（非纯数字 / 月日越界）→ null。
 */
function parseMrzDate(yymmdd: string, kind: 'birth' | 'expiry'): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;

  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));

  if (mm < 1 || mm > 12) return null;
  if (dd < 1 || dd > 31) return null;

  let year: number;
  if (kind === 'expiry') {
    year = 2000 + yy;
  } else {
    const currentTwoDigit = new Date().getFullYear() % 100;
    year = yy > currentTwoDigit ? 1900 + yy : 2000 + yy;
    // 若得出的出生日期落在未来 → 再减 100 年
    const now = new Date();
    const candidate = new Date(Date.UTC(year, mm - 1, dd));
    if (candidate.getTime() > now.getTime()) {
      year -= 100;
    }
  }

  const mmStr = String(mm).padStart(2, '0');
  const ddStr = String(dd).padStart(2, '0');
  return `${year}-${mmStr}-${ddStr}`;
}

/** 把 MRZ 名字字段里的 '<' 转空格并折叠、trim。 */
function cleanNamePart(part: string): string {
  return part.replace(/</g, ' ').replace(/\s+/g, ' ').trim();
}

/** MRZ 性别位 → M/F/X。 */
function parseSex(c: string): string {
  if (c === 'M') return 'M';
  if (c === 'F') return 'F';
  return 'X';
}

/**
 * 解析 TD3 护照 MRZ 两行。
 * @returns 解析结果；行长非 44 / 含非法字符导致无法解析 → null。
 *          可解析但校验位不全通过 → valid:false（字段仍返回）。
 */
export function parseTd3Mrz(line1Raw: string, line2Raw: string): MrzResult | null {
  if (typeof line1Raw !== 'string' || typeof line2Raw !== 'string') return null;

  const line1 = line1Raw.trim().toUpperCase();
  const line2 = line2Raw.trim().toUpperCase();

  if (line1.length !== TD3_LINE_LENGTH || line2.length !== TD3_LINE_LENGTH) {
    return null;
  }

  // 合法字符集：A-Z / 0-9 / '<'
  const legal = /^[A-Z0-9<]+$/;
  if (!legal.test(line1) || !legal.test(line2)) return null;

  // ---- 第 1 行：类型(1-2) + 签发国(3-5) + 姓名(6-44) ----
  const nameField = line1.slice(5); // positions 6..44
  const sepIdx = nameField.indexOf('<<');
  const surnameRaw = sepIdx >= 0 ? nameField.slice(0, sepIdx) : nameField;
  const givenRaw = sepIdx >= 0 ? nameField.slice(sepIdx + 2) : '';
  const surname = cleanNamePart(surnameRaw);
  const givenNames = cleanNamePart(givenRaw);

  // ---- 第 2 行字段切分 ----
  const passportNumberField = line2.slice(0, 9); // 1-9
  const passportNumberCheck = line2[9]; // 10
  const nationality = line2.slice(10, 13); // 11-13
  const birthField = line2.slice(13, 19); // 14-19
  const birthCheck = line2[19]; // 20
  const sexChar = line2[20]; // 21
  const expiryField = line2.slice(21, 27); // 22-27
  const expiryCheck = line2[27]; // 28
  const personalField = line2.slice(28, 42); // 29-42
  const personalCheck = line2[42]; // 43
  const compositeCheck = line2[43]; // 44

  const checks: MrzChecks = {
    passportNumber: verifyField(passportNumberField, passportNumberCheck),
    dateOfBirth: verifyField(birthField, birthCheck),
    expiryDate: verifyField(expiryField, expiryCheck),
    personalNumber: verifyField(personalField, personalCheck),
    composite: false,
  };

  // 复合校验位覆盖 第2行 1-10、14-20、22-43
  const compositeField =
    line2.slice(0, 10) + line2.slice(13, 20) + line2.slice(21, 43);
  checks.composite = verifyField(compositeField, compositeCheck);

  const dateOfBirth = parseMrzDate(birthField, 'birth');
  const expiryDate = parseMrzDate(expiryField, 'expiry');

  const valid =
    checks.passportNumber &&
    checks.dateOfBirth &&
    checks.expiryDate &&
    checks.personalNumber &&
    checks.composite &&
    dateOfBirth !== null &&
    expiryDate !== null;

  return {
    valid,
    surname,
    givenNames,
    passportNumber: passportNumberField.replace(/</g, ''),
    nationality: nationality.replace(/</g, ''),
    dateOfBirth: dateOfBirth ?? '',
    sex: parseSex(sexChar),
    expiryDate: expiryDate ?? '',
    checks,
  };
}
