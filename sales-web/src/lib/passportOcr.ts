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
 */
function parseMRZ(text: string): OcrResult['mrz'] | undefined {
  // MRZ 用 < 做填充符，每行 44 字符
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  // 找 2 行都以 < 或字母开头、长度接近 44 的连续两行
  for (let i = 0; i < lines.length - 1; i++) {
    const l1 = lines[i].replace(/\s/g, '');
    const l2 = lines[i + 1].replace(/\s/g, '');
    // 第一行必须 P 开头（Passport）
    if (!l1.startsWith('P') || l1.length < 30) continue;
    if (l2.length < 30) continue;

    try {
      // TD3 line 1: P<CCC<SURNAME<<GIVENNAME...
      const nameField = l1.substring(5).replace(/</g, ' ').trim();
      const [surname, ...givenParts] = nameField.split(/\s{2,}/);
      const givenNames = givenParts.join(' ').trim();

      // TD3 line 2:
      // 0-8: passport number (9 chars, padded with <)
      // 9: check digit
      // 10-12: nationality (3 letters)
      // 13-18: DOB YYMMDD
      // 19: check digit
      // 20: sex
      // 21-26: expiry YYMMDD
      const passportNumber = l2.substring(0, 9).replace(/</g, '');
      const nationality = l2.substring(10, 13);
      const dobRaw = l2.substring(13, 19);
      const sex = l2.substring(20, 21) as 'M' | 'F' | 'X';
      const expiryRaw = l2.substring(21, 27);

      return {
        surname: surname.trim(),
        givenNames: givenNames.trim(),
        passportNumber,
        nationality,
        dateOfBirth: yymmddToIso(dobRaw, true), // 假设 19xx/20xx
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

  // 中国护照号：E/G/S/D/P + 8 数字（现役大部分是 E 开头）
  const passportMatch = text.match(/\b[EGSDPH]\d{8}\b/);
  if (passportMatch) result.passportNumber = passportMatch[0];

  // 中文姓名：2-4 个汉字连在一起（在"姓名"附近优先）
  const chineseNameMatch = text.match(/姓名[\s:：]*([\u4e00-\u9fa5]{2,4})/);
  if (chineseNameMatch) {
    result.chineseName = chineseNameMatch[1];
  } else {
    const firstChineseName = text.match(/[\u4e00-\u9fa5]{2,4}/);
    if (firstChineseName) result.chineseName = firstChineseName[0];
  }

  // 英文拼音名（大写字母 + 空格，至少 2 段）
  const englishNameMatch = text.match(/([A-Z]{2,}[\s,]+[A-Z]{2,}(?:\s+[A-Z]{2,})?)/);
  if (englishNameMatch) result.englishName = englishNameMatch[1].replace(/\s+/g, ' ').trim();

  // 出生日期 YYYY-MM-DD 或 DD MMM YYYY
  const dobMatch = text.match(/(\d{4})[-\s/](\d{1,2})[-\s/](\d{1,2})/);
  if (dobMatch) {
    result.dateOfBirth = `${dobMatch[1]}-${dobMatch[2].padStart(2, '0')}-${dobMatch[3].padStart(2, '0')}`;
  }

  return result;
}
