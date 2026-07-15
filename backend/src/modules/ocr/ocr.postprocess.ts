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

const CONFIDENCE_THRESHOLD = 98;

/** 需要人工核对的非 MRZ 字段（按置信度判定）。 */
const NON_MRZ_FIELDS = [
  'chineseName',
  'passportIssueDate',
  'passportIssuePlace',
  'placeOfBirth',
] as const;

function trimOrNull(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return v ?? null;
  const t = v.trim();
  return t === '' ? null : t;
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
    // 姓名以 MRZ 为准
    lastName = trimOrNull(mrz.surname);
    firstName = trimOrNull(mrz.givenNames);
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

  // 非 MRZ 字段置信度核对
  const conf = raw.fieldConfidence ?? null;
  const nonMrzValues: Record<(typeof NON_MRZ_FIELDS)[number], string | null> = {
    chineseName: trimOrNull(raw.chineseName),
    passportIssueDate: trimOrNull(raw.passportIssueDate),
    passportIssuePlace: trimOrNull(raw.passportIssuePlace),
    placeOfBirth: trimOrNull(raw.placeOfBirth),
  };

  for (const field of NON_MRZ_FIELDS) {
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
