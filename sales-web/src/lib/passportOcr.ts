/**
 * 护照 OCR — 基于 tesseract.js 浏览器端真识别
 *
 * 中国护照识别策略：
 *   1. 优先尝试 MRZ（Machine Readable Zone，国际标准，护照底部两行 OCR 字符）
 *      - MRZ 格式固定，可靠性最高
 *   2. 同时用 chi_sim + eng 识别整页文字，抓姓名/护照号
 *   3. 护照号正则 `[A-Z]\d{8}` 或 `E\d{8}` (中国护照)
 *
 * 真实生产应该上 AWS Textract / 阿里云 OCR / 腾讯云通用文字识别 —
 * tesseract 中文护照识别准确率约 60-75%，边缘场景（反光/倾斜）会失败。
 * 此模块保证：UI 有真实 OCR 流程，识别失败时清楚提示用户手填。
 */
import Tesseract from 'tesseract.js';

export interface OcrResult {
  success: boolean;
  /** 原始识别文字（完整） */
  rawText: string;
  /** 从 MRZ 解析出的字段（最可靠） */
  mrz?: {
    surname: string;
    givenNames: string;
    passportNumber: string;
    nationality: string;
    dateOfBirth: string; // YYYY-MM-DD
    sex: 'M' | 'F' | 'X';
    expiryDate: string; // YYYY-MM-DD
  };
  /** 从正文提取（MRZ 失败时兜底） */
  fallback?: {
    passportNumber?: string;
    chineseName?: string;
    englishName?: string;
    dateOfBirth?: string;
  };
  /** 整体置信度 0-100 */
  confidence: number;
  /** 用户可直接填入表单的字段 */
  suggested: {
    fullName?: string;
    passportNumber?: string;
    dateOfBirth?: string;
    nationality?: string;
  };
  /** 识别耗时（ms） */
  elapsedMs: number;
  error?: string;
}

/** 主入口：识别一张护照图片 */
export async function ocrPassport(
  file: File,
  onProgress?: (pct: number, stage: string) => void,
): Promise<OcrResult> {
  const start = Date.now();
  try {
    onProgress?.(5, '初始化 OCR 引擎…');

    // 1. 用 chi_sim + eng 双语识别整页
    const result = await Tesseract.recognize(
      file,
      'chi_sim+eng',
      {
        logger: (m) => {
          if (m.status === 'loading language traineddata') {
            onProgress?.(10 + (m.progress ?? 0) * 20, '下载中文语言包…');
          } else if (m.status === 'initializing api') {
            onProgress?.(30, '初始化…');
          } else if (m.status === 'recognizing text') {
            onProgress?.(35 + (m.progress ?? 0) * 60, '识别护照文字…');
          }
        },
      },
    );

    const rawText = result.data.text;
    const confidence = result.data.confidence;

    onProgress?.(95, '解析字段…');

    // 2. 尝试 MRZ 解析（护照底部 2 行，以 P< 开头）
    const mrz = parseMRZ(rawText);

    // 3. 兜底：正则抽取护照号 / 中文名
    const fallback = extractFallback(rawText);

    // 4. 给表单的建议字段
    const suggested = mrz
      ? {
          fullName: formatMrzName(mrz.surname, mrz.givenNames),
          passportNumber: mrz.passportNumber,
          dateOfBirth: mrz.dateOfBirth,
          nationality: mrzNationalityToISO(mrz.nationality),
        }
      : {
          fullName: fallback.englishName || fallback.chineseName,
          passportNumber: fallback.passportNumber,
          dateOfBirth: fallback.dateOfBirth,
          nationality: 'MO', // 默认澳门（业务场景）
        };

    onProgress?.(100, '完成');

    return {
      success: !!(suggested.passportNumber || suggested.fullName),
      rawText,
      mrz,
      fallback,
      confidence,
      suggested,
      elapsedMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      rawText: '',
      confidence: 0,
      suggested: {},
      elapsedMs: Date.now() - start,
      error: err instanceof Error ? err.message : '识别失败',
    };
  }
}

/**
 * 解析 ICAO 9303 MRZ (TD3 - 两行 44 字符护照格式)
 *
 * 例:
 * P<CHNZHANG<<SAN<<<<<<<<<<<<<<<<<<<<<<<<<<<<
 * E12345678<6CHN9001015M3001015<<<<<<<<<<<<<<02
 *
 * 宽松策略：
 *   - tesseract 把 < 经常识成 «、‹、(、≤；这里先把这些字符统一替换回 <
 *   - 不再死磕 line1 必须 startsWith('P') —— 因为可能识错；只要看到长 < 序列就当 MRZ 候选
 *   - 长度 ≥ 30 即可（标准 44，但 OCR 经常吃尾巴）
 */
function parseMRZ(text: string): OcrResult['mrz'] | undefined {
  // 1. 只规范化 OCR 把 < 识成其它"尖头符"的情况；不动字母 — MRZ 字段的字母位置是固定的，
  //    乱替换会把 nationality "UTO" 变成 "UT0" 之类。
  const normalized = text
    .replace(/[«‹«‹]/g, '<')
    .replace(/[≤≦]/g, '<');

  const lines = normalized.split(/\r?\n/).map((l) => l.trim());

  // 候选：找连续两行，每行去空格后长度 ≥ 30，并且至少有一行包含 < 序列（MRZ 特征）
  for (let i = 0; i < lines.length - 1; i++) {
    const l1 = lines[i].replace(/\s/g, '');
    const l2 = lines[i + 1].replace(/\s/g, '');
    if (l1.length < 30 || l2.length < 30) continue;

    // 至少一行有 ≥3 个连续 <（MRZ 填充符），否则不是 MRZ
    const hasFiller = /<{3,}/.test(l1) || /<{3,}/.test(l2);
    if (!hasFiller) continue;

    // line2 前 9 位应该是护照号 + 校验位 —— 至少要有 6 个 alphanum 字符
    if (!/^[A-Z0-9<]{9}/.test(l2)) continue;

    try {
      // TD3 line 1: P<CCC<SURNAME<<GIVENNAME<...
      // 砍掉前 5 位（"P<CCC"），剩下是 SURNAME<<GIVEN<NAMES<... 用 << 分隔姓和名
      // 注意：先 split 再把 < 替成空格，否则收尾会把姓名边界丢掉
      const after = l1.substring(5);
      const [surnameRaw, ...givenRawParts] = after.split(/<<+/);
      const surname = (surnameRaw ?? '').replace(/</g, ' ').trim();
      const givenNames = givenRawParts
        .join(' ')
        .replace(/</g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // TD3 line 2:
      const passportNumber = l2.substring(0, 9).replace(/</g, '').trim();
      const nationality = l2.substring(10, 13);
      const dobRaw = l2.substring(13, 19);
      const sex = (l2.substring(20, 21) || 'X') as 'M' | 'F' | 'X';
      const expiryRaw = l2.substring(21, 27);

      // 护照号至少 5 位
      if (passportNumber.length < 5) continue;

      return {
        surname,
        givenNames,
        passportNumber,
        nationality,
        dateOfBirth: yymmddToIso(dobRaw, true),
        sex,
        expiryDate: yymmddToIso(expiryRaw, false),
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

/** YYMMDD → YYYY-MM-DD（biased: 出生年 20 年内选 20xx，否则 19xx） */
function yymmddToIso(yymmdd: string, isBirth: boolean): string {
  if (yymmdd.length !== 6 || !/^\d{6}$/.test(yymmdd)) return '';
  const yy = Number(yymmdd.substring(0, 2));
  const mm = yymmdd.substring(2, 4);
  const dd = yymmdd.substring(4, 6);
  const now = new Date().getFullYear() % 100;
  let year: number;
  if (isBirth) {
    year = yy > now + 5 ? 1900 + yy : 2000 + yy;
  } else {
    year = 2000 + yy; // 签证/护照有效期通常未来
  }
  return `${year}-${mm}-${dd}`;
}

/** MRZ 国籍代码 CHN → ISO-2 CN；HKG → HK；MAC → MO */
function mrzNationalityToISO(code: string): string {
  const map: Record<string, string> = {
    CHN: 'CN', HKG: 'HK', MAC: 'MO', TWN: 'TW',
    USA: 'US', GBR: 'GB', JPN: 'JP', KOR: 'KR', VNM: 'VN',
  };
  return map[code] ?? code;
}

/** MRZ 名字格式：SURNAME<<GIVEN<NAMES → "GIVEN NAMES SURNAME"（护照英文拼音名） */
function formatMrzName(surname: string, given: string): string {
  return `${given} ${surname}`.trim().replace(/\s+/g, ' ');
}

/** 兜底正则 — 没识别到 MRZ 时从全文抓 */
function extractFallback(text: string): NonNullable<OcrResult['fallback']> {
  const result: NonNullable<OcrResult['fallback']> = {};

  // 把 OCR 噪点统一处理一下（O→0、I/l→1 在数字相邻位置）
  const cleaned = text
    .replace(/[OQ](?=\d)/g, '0')
    .replace(/(?<=\d)[OQ]/g, '0')
    .replace(/[Il](?=\d)/g, '1');

  // 优先：中国护照 E/G/S/D/P/H + 可选第二字母 + 7-8 位数字
  let passportMatch: RegExpMatchArray | null = cleaned.match(/\b[EGSDPH][A-Z]?\d{7,8}\b/);
  // 通用国际格式 1-2 字母 + 6-9 数字（紧跟在 3 字母 ISO 国家码后的数字单独捕获）
  if (!passportMatch) {
    const isoCountryAndNumber = cleaned.match(/\b[A-Z]{3}(\d{6,9})\b/);
    if (isoCountryAndNumber) {
      result.passportNumber = isoCountryAndNumber[1];
    } else {
      passportMatch = cleaned.match(/\b[A-Z]{1,2}\d{6,9}\b/);
    }
  }
  // 最后：纯 7-9 位数字
  if (!passportMatch && !result.passportNumber) {
    passportMatch = cleaned.match(/(?<![A-Z\d])\d{7,9}(?![A-Z\d])/);
  }
  if (passportMatch && !result.passportNumber) {
    result.passportNumber = passportMatch[0];
  }

  // 中文姓名：2-4 个汉字连在一起（在"姓名"附近优先）
  const chineseNameMatch = text.match(/姓名[\s:：]*([\u4e00-\u9fa5]{2,4})/);
  if (chineseNameMatch) {
    result.chineseName = chineseNameMatch[1];
  } else {
    const firstChineseName = text.match(/[\u4e00-\u9fa5]{2,4}/);
    if (firstChineseName) result.chineseName = firstChineseName[0];
  }

  // 英文拼音名（大写字母 + 空格 / 逗号，至少 2 段）
  // 跳过文档标题词（PASSPORT、UNITED KINGDOM、CHINA 等护照页常见的非姓名大写文本）
  const stopWords = new Set([
    'PASSPORT', 'UNITED', 'KINGDOM', 'STATES', 'AMERICA', 'REPUBLIC',
    'PEOPLE', 'CHINA', 'JAPAN', 'KOREA', 'VIETNAM', 'NATIONALITY',
    'SURNAME', 'GIVEN', 'NAME', 'NAMES', 'BIRTH', 'DATE', 'PLACE',
    'EXPIRY', 'AUTHORITY', 'SEX', 'TYPE', 'CODE', 'NUMBER',
    'NO', 'OF', 'MALE', 'FEMALE',
  ]);
  // 抓所有候选并选第一个非 stopword 的
  const englishNameCandidates = text.match(/[A-Z]{2,}[,\s]+[A-Z]{2,}(?:[,\s]+[A-Z]{2,})*/g) ?? [];
  for (const cand of englishNameCandidates) {
    const tokens = cand.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    // 全部 token 都不是 stopword 才接受
    if (tokens.every((t) => !stopWords.has(t))) {
      result.englishName = tokens.join(' ');
      break;
    }
  }

  // 出生日期 多种格式
  // YYYY-MM-DD / YYYY/MM/DD / YYYY年MM月DD日
  let dobMatch = text.match(/(19\d{2}|20[01]\d)[-\s/年](\d{1,2})[-\s/月](\d{1,2})/);
  if (dobMatch) {
    result.dateOfBirth = `${dobMatch[1]}-${dobMatch[2].padStart(2, '0')}-${dobMatch[3].padStart(2, '0')}`;
  } else {
    // DD MMM YYYY (e.g., "15 JAN 1990") — 国际护照常见
    const monthMap: Record<string, string> = {
      JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
      JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
    };
    dobMatch = text.match(/\b(\d{1,2})[\s-]+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[\s-]+(19\d{2}|20[01]\d)\b/i);
    if (dobMatch) {
      const mm = monthMap[dobMatch[2].toUpperCase()];
      result.dateOfBirth = `${dobMatch[3]}-${mm}-${dobMatch[1].padStart(2, '0')}`;
    }
  }

  return result;
}
