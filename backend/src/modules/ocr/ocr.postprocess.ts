/**
 * 护照 OCR 后处理（确定性纯函数，不信 LLM 自评）
 *
 * 目标（票务岗反馈）：
 *  - 提醒录单人哪些字段需要人工二次核对（护照反光等致目视区误读）。
 *  - 姓名格式在系统边界统一，避免脏数据入库。
 *
 * 处理规则：
 *  1. MRZ 两行齐且校验位通过 → 用机读区值覆盖 documentNumber/dateOfBirth/
 *     passportExpiry/gender/nationality（及姓名 compose）；与目视区不一致的
 *     字段记入 reviewFields。
 *  2. MRZ 缺失或校验位不过 → 全部机读字段进 reviewFields（逐项人工核对）。
 *  3. 非 MRZ 字段（chineseName/passportIssueDate/passportIssuePlace/
 *     placeOfBirth）：置信度 < 98 或缺失 → 进 reviewFields。
 *  4. 签发地点兜底（见 checkIssuePlace）：含签发机关字样 → 不填入并提示手填；
 *     「中文/拼音」原文 → 取斜杠前中文；「X省Y市」这类多级地名 → 保留但提示核对。
 *     规则命中时不再叠加置信度提示（一个字段只给一条原因）。
 */
import {
  composePassengerFullName,
  normalizePassengerFullName,
} from '../../lib/passenger-name.js';
import { parseTd3Mrz } from './mrz.js';

/** LLM 原始输出（宽松，字段可缺可 null）。 */
export interface RawOcrFields {
  lastName?: string | null;
  firstName?: string | null;
  fullName?: string | null;
  chineseName?: string | null;
  documentNumber?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  nationality?: string | null;
  passportIssueCountry?: string | null;
  passportExpiry?: string | null;
  passportIssueDate?: string | null;
  passportIssuePlace?: string | null;
  placeOfBirth?: string | null;
  mrzLine1?: string | null;
  mrzLine2?: string | null;
  fieldConfidence?: Record<string, number> | null;
}

export interface ReviewField {
  field: string;
  reason: string;
}

/** 对外响应里 suggested 的确定形状（向后兼容原 13 键）。 */
export interface SuggestedFields {
  lastName: string | null;
  firstName: string | null;
  fullName: string | null;
  chineseName: string | null;
  documentNumber: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  nationality: string | null;
  passportIssueCountry: string | null;
  passportExpiry: string | null;
  passportIssueDate: string | null;
  passportIssuePlace: string | null;
  placeOfBirth: string | null;
}

export interface PostProcessResult {
  suggested: SuggestedFields;
  verify: {
    mrzValid: boolean;
    reviewFields: ReviewField[];
  };
}

const REASON_MRZ_MISMATCH =
  'MRZ 与目视区不一致，已按机读区取值，请人工复核';
const REASON_MRZ_UNVERIFIED = '机读区未能校验，请逐项人工核对';
const REASON_LOW_CONFIDENCE = '识别置信度不足，请人工核对';
const REASON_MRZ_NAME_UNVERIFIED = '机读区姓名行长度有误，姓名未经校验，请照护照核对';
const REASON_ISSUE_PLACE_AUTHORITY = '疑似签发机关，未填入，请照护照「签发地点」栏手填';
const REASON_ISSUE_PLACE_MULTI_LEVEL = '护照只印省份，结果带了下级地名，请核对';

const CONFIDENCE_THRESHOLD = 98;

/**
 * 签发机关特征词：签发地点里出现即判定模型把「签发机关/Authority」栏填了进来。
 * 中国护照的签发机关是出入境 / 移民管理部门（或驻外使领馆），外国护照多是外交部、移民局一类
 * 部门；签发地点栏只印地名，不会出现这些字。「公安」只认部 / 厅 / 局，不单认二字（有地名叫公安县）。
 */
const ISSUING_AUTHORITY_PATTERN =
  /管理局|公安部|公安厅|公安廳|公安局|出入境|移民管理|入境事务|入境事務|外交部|使馆|使館|领事馆|領事館|ADMINISTRATION|MINISTRY|PUBLIC\s*SECURITY|IMMIGRATION|BUREAU|DEPARTMENT|EMBASSY|CONSULATE/i;

/** 中国护照签发地点栏的印刷格式「中文/拼音」（斜杠含全角）：取斜杠前的中文（与提示词口径一致）。 */
const CN_BILINGUAL_PLACE_PATTERN = /^(\p{Script=Han}+)\s*[/／]\s*[A-Za-z][A-Za-z .'-]*$/u;

/**
 * 多级地名：「省 / 自治区 / 市」后面还跟着字（如「X省Y市」「X市Y区」）。护照签发地点栏只印
 * 省级名称、从不印到下一级，这种值多半是模型自行补全的（旧提示词里被照抄的示例就是这种格式）。
 * 单级写法（「X省」「X市」）只是多了个后缀字，不拦。
 */
const MULTI_LEVEL_PLACE_PATTERN = /(省|自治区|市).+/;

/**
 * 需要人工核对的非 MRZ 字段（按置信度判定）。
 * 提示词的 fieldConfidence 只要这几个键（ocr.prompt.ts 由此生成）：MRZ 字段靠校验位验证、
 * 从不看置信度，让模型给它们打分只是白白多吐 token。
 */
export const NON_MRZ_FIELDS = [
  'chineseName',
  'passportIssueDate',
  'passportIssuePlace',
  'placeOfBirth',
] as const;

type NonMrzField = (typeof NON_MRZ_FIELDS)[number];

function trimOrNull(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return v ?? null;
  const t = v.trim();
  return t === '' ? null : t;
}

interface IssuePlaceCheck {
  value: string | null;
  /** 规则命中时的核对原因；null = 规则放行（照常按置信度判定）。 */
  reason: string | null;
}

/**
 * 签发地点确定性兜底（提示词之外的第二道闸）：
 *  - 含签发机关字样 → 不填入（null）并提示手填：错的机关名进了 PNR / 送签表，比空着更糟；
 *  - 「中文/拼音」原文 → 取斜杠前中文（就是护照印的字，不算改值，不提示）；
 *  - 「X省Y市」这类多级地名 → 保留原值，但提示核对。
 */
function checkIssuePlace(raw: string | null): IssuePlaceCheck {
  // 模型偶尔给出非字符串（数字 / 对象）：不套规则，原样交给后续（与改前一致）
  if (typeof raw !== 'string') return { value: raw, reason: null };
  if (ISSUING_AUTHORITY_PATTERN.test(raw)) {
    return { value: null, reason: REASON_ISSUE_PLACE_AUTHORITY };
  }
  const bilingual = CN_BILINGUAL_PLACE_PATTERN.exec(raw);
  const value = bilingual ? bilingual[1] : raw;
  if (MULTI_LEVEL_PLACE_PATTERN.test(value)) {
    return { value, reason: REASON_ISSUE_PLACE_MULTI_LEVEL };
  }
  return { value, reason: null };
}

/**
 * 目视区读到的拉丁字母姓名与机读区是否不一致：只比 A-Z 字母（空格、连字符、逗号在机读区都是 '<'）。
 * 目视区没读到、或读到的不含拉丁字母（比如给了中文）→ 不比，返回 false。
 */
function latinNameDiffers(visual: string | null, mrzVal: string): boolean {
  const letters = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, '');
  if (visual == null || letters(visual) === '') return false;
  return letters(visual) !== letters(mrzVal);
}

/** 宽松比较两个值是否“不一致”（大写去空白后比较；null 视为与非 null 不一致）。 */
function differs(a: string | null, b: string | null): boolean {
  const na = a == null ? '' : a.trim().toUpperCase();
  const nb = b == null ? '' : b.trim().toUpperCase();
  return na !== nb;
}

/**
 * 护照 OCR 后处理主函数。输入 LLM 原始字段，输出规范化后的 suggested + verify。
 */
export function applyOcrPostProcessing(raw: RawOcrFields): PostProcessResult {
  const reviewFields: ReviewField[] = [];

  // LLM 机读字段（trim 后）
  const llmDocumentNumber = trimOrNull(raw.documentNumber);
  const llmDateOfBirth = trimOrNull(raw.dateOfBirth);
  const llmPassportExpiry = trimOrNull(raw.passportExpiry);
  const llmGender = trimOrNull(raw.gender);
  const llmNationality = trimOrNull(raw.nationality);
  const llmLastName = trimOrNull(raw.lastName);
  const llmFirstName = trimOrNull(raw.firstName);
  const llmFullName = trimOrNull(raw.fullName);

  const mrz =
    raw.mrzLine1 && raw.mrzLine2
      ? parseTd3Mrz(raw.mrzLine1, raw.mrzLine2)
      : null;
  const mrzValid = mrz != null && mrz.valid;

  // 机读字段最终取值：默认 LLM 值
  let documentNumber = llmDocumentNumber;
  let dateOfBirth = llmDateOfBirth;
  let passportExpiry = llmPassportExpiry;
  let gender = llmGender;
  let nationality = llmNationality;
  let lastName = llmLastName;
  let firstName = llmFirstName;

  if (mrzValid && mrz) {
    // 用 MRZ 覆盖机读字段，逐项与 LLM 比对，不一致记 review
    const overrides: Array<{ field: string; mrzVal: string; llmVal: string | null }> = [
      { field: 'documentNumber', mrzVal: mrz.passportNumber, llmVal: llmDocumentNumber },
      { field: 'dateOfBirth', mrzVal: mrz.dateOfBirth, llmVal: llmDateOfBirth },
      { field: 'passportExpiry', mrzVal: mrz.expiryDate, llmVal: llmPassportExpiry },
      { field: 'gender', mrzVal: mrz.sex, llmVal: llmGender },
      { field: 'nationality', mrzVal: mrz.nationality, llmVal: llmNationality },
    ];

    for (const o of overrides) {
      if (differs(o.llmVal, o.mrzVal)) {
        reviewFields.push({ field: o.field, reason: REASON_MRZ_MISMATCH });
      }
    }

    documentNumber = trimOrNull(mrz.passportNumber);
    dateOfBirth = trimOrNull(mrz.dateOfBirth);
    passportExpiry = trimOrNull(mrz.expiryDate);
    gender = trimOrNull(mrz.sex);
    nationality = trimOrNull(mrz.nationality);

    // 姓名在第 1 行，第 1 行没有任何校验位（上面的校验只覆盖第 2 行）。
    const names = [
      { field: 'lastName', mrzVal: mrz.surname, llmVal: llmLastName },
      { field: 'firstName', mrzVal: mrz.givenNames, llmVal: llmFirstName },
    ];
    if (mrz.line1Normalized) {
      // 第 1 行是补齐 / 截断过填充符才能解析的：姓名里漏抄一个字母补齐后也完全合法，
      // 不能静默采用——姓名回到目视区取值（与第 1 行无法解析时同口径），并提示核对。
      lastName = llmLastName ?? trimOrNull(mrz.surname);
      firstName = llmFirstName ?? trimOrNull(mrz.givenNames);
      for (const n of names) reviewFields.push({ field: n.field, reason: REASON_MRZ_NAME_UNVERIFIED });
    } else {
      // 姓名以 MRZ 为准；目视区读到的拉丁字母姓名与之不一致时提示核对
      lastName = trimOrNull(mrz.surname);
      firstName = trimOrNull(mrz.givenNames);
      for (const n of names) {
        if (latinNameDiffers(n.llmVal, n.mrzVal)) {
          reviewFields.push({ field: n.field, reason: REASON_MRZ_MISMATCH });
        }
      }
    }
  } else {
    // MRZ 缺失或校验不过：全部机读字段进 review
    for (const field of [
      'documentNumber',
      'dateOfBirth',
      'passportExpiry',
      'gender',
      'nationality',
    ]) {
      reviewFields.push({ field, reason: REASON_MRZ_UNVERIFIED });
    }
  }

  // 姓名规范化：优先 compose(lastName, firstName)，否则规范化 LLM fullName
  const composed = composePassengerFullName(lastName, firstName);
  let fullName: string | null;
  if (composed) {
    fullName = composed;
  } else if (llmFullName) {
    const n = normalizePassengerFullName(llmFullName);
    fullName = n === '' ? null : n;
  } else {
    fullName = null;
  }

  // 非 MRZ 字段：规则判定的原因优先（更具体），否则按置信度核对。一个字段只给一条原因。
  const conf = raw.fieldConfidence ?? null;
  const issuePlace = checkIssuePlace(trimOrNull(raw.passportIssuePlace));
  const ruleReasons: Partial<Record<NonMrzField, string>> = issuePlace.reason
    ? { passportIssuePlace: issuePlace.reason }
    : {};
  const nonMrzValues: Record<NonMrzField, string | null> = {
    chineseName: trimOrNull(raw.chineseName),
    passportIssueDate: trimOrNull(raw.passportIssueDate),
    passportIssuePlace: issuePlace.value,
    placeOfBirth: trimOrNull(raw.placeOfBirth),
  };

  for (const field of NON_MRZ_FIELDS) {
    const ruleReason = ruleReasons[field];
    if (ruleReason) {
      reviewFields.push({ field, reason: ruleReason });
      continue;
    }
    const value = nonMrzValues[field];
    if (value == null) continue; // 无值无需核对（空字段本身已提示）
    const c = conf?.[field];
    if (typeof c !== 'number' || c < CONFIDENCE_THRESHOLD) {
      reviewFields.push({ field, reason: REASON_LOW_CONFIDENCE });
    }
  }

  const suggested: SuggestedFields = {
    lastName,
    firstName,
    fullName,
    chineseName: nonMrzValues.chineseName,
    documentNumber,
    dateOfBirth,
    gender,
    nationality,
    passportIssueCountry: trimOrNull(raw.passportIssueCountry),
    passportExpiry,
    passportIssueDate: nonMrzValues.passportIssueDate,
    passportIssuePlace: nonMrzValues.passportIssuePlace,
    placeOfBirth: nonMrzValues.placeOfBirth,
  };

  return {
    suggested,
    verify: { mrzValid, reviewFields },
  };
}
