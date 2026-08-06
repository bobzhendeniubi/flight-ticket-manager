/**
 * 护照 OCR 识别 —— 共享 runner（从 SingleOrderModal 同款实现模式抽取，供批量创单等其它录单入口复用）。
 *
 * 策略与 SingleOrderModal 一致：
 *   1. 先尝试后端 AI 识别（POST /ocr/passport）。configured:true 且 suggested 有结果 → 用 AI 结果，
 *      引擎标 'ai'（含 model 名 + 逐字段人工核对提示 reviewFields + MRZ 校验结果）。
 *   2. AI 未配置（configured:false）→ 直接本地 Tesseract，引擎标 'local'。
 *   3. AI 配了但识别失败（suggested 为 null / 请求异常）→ 回退本地 Tesseract，引擎标 'ai-fallback'。
 *
 * 注意：这里只做识别 + 结果整形，不碰任何 UI 状态——调用方（如批量创单表格）自行决定如何落到自己的
 * 行状态里；SingleOrderModal 保留它自己的内联实现不变，本文件不是它的替代品，只是同款逻辑的复用面。
 */
import { api, type AiOcrPassportResult } from './api';
import { normalizePassengerFullName } from './passengerName';

export type PassportOcrEngine = 'ai' | 'local' | 'ai-fallback';

export interface PassportOcrPatch {
  fullName?: string;
  documentNumber?: string;
  dateOfBirth?: string;
  gender?: 'M' | 'F' | 'X';
  chineseName?: string;
  passportIssueDate?: string;
  passportIssuePlace?: string;
  passportExpiry?: string;
  /** 存库用压缩图 data URL；压缩失败时缺省（不阻断识别本身） */
  passportPhotoUrl?: string;
  ocrPct: number | null;
  ocrStage?: string;
  ocrEngine: PassportOcrEngine | null;
  ocrModel?: string | null;
  /** AI 识别时需人工核对的字段（后端 verify.reviewFields 透传） */
  reviewFields?: Array<{ field: string; reason: string }>;
  /** 护照 MRZ 校验是否通过；本地识别路径无此信息 */
  mrzValid?: boolean | null;
  /** 本地 Tesseract 兜底识别提示：精度有限，需整行核对 */
  localOcrCaveat?: boolean;
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('读取失败'));
    reader.onerror = () => reject(new Error('读取失败'));
    reader.readAsDataURL(file);
  });
}

/** 本地 Tesseract 识别（AI 未配置/失败时的兜底路径） */
async function runLocalOcr(
  file: File,
  engine: 'local' | 'ai-fallback',
  onProgress?: (pct: number, stage: string) => void,
): Promise<PassportOcrPatch> {
  try {
    const { ocrPassport } = await import('./passportOcr');
    const result = await ocrPassport(file, (pct, stage) => {
      onProgress?.(20 + Math.round(pct * 0.8), stage);
    });
    const s = result.suggested;
    const patch: PassportOcrPatch = {
      ocrPct: 100,
      ocrStage: result.success ? '识别完成' : '识别不完整，请核对',
      ocrEngine: engine,
      ocrModel: null,
      reviewFields: undefined,
      mrzValid: null,
      localOcrCaveat: true,
    };
    if (s.fullName) patch.fullName = normalizePassengerFullName(s.fullName);
    if (s.passportNumber) patch.documentNumber = s.passportNumber;
    if (s.dateOfBirth) patch.dateOfBirth = s.dateOfBirth;
    if (s.gender) patch.gender = s.gender;
    return patch;
  } catch {
    return { ocrPct: null, ocrStage: undefined, ocrEngine: null, ocrModel: null };
  }
}

/**
 * 识别一张护照图片：先压缩出存库图，再走 AI 优先 / 本地兜底识别，返回可直接 patch 到行状态的结果。
 * `onProgress` 仅用于展示识别进度条，不影响识别策略。
 */
export async function runPassportOcr(
  token: string,
  file: File,
  onProgress?: (pct: number, stage: string) => void,
): Promise<PassportOcrPatch> {
  onProgress?.(0, '加载中…');

  // ── 1. 存库图压缩（长边 ≤1600 + JPEG ≤~700KB）──
  let dataUrl = '';
  try {
    const { passportPhotoToDataUrl } = await import('./passportOcr');
    dataUrl = await passportPhotoToDataUrl(file);
  } catch {
    dataUrl = '';
  }
  const base: Pick<PassportOcrPatch, 'passportPhotoUrl'> = dataUrl ? { passportPhotoUrl: dataUrl } : {};

  // ── 2. 无 token（不应出现，保险兜底）→ 直接本地 ──
  if (!token) {
    return { ...base, ...(await runLocalOcr(file, 'local', onProgress)) };
  }

  // ── 3. 尝试 AI 识别 ──
  try {
    onProgress?.(20, 'AI 识别中…');
    const imageDataUrl = dataUrl || (await fileToDataUrl(file));
    const aiRes: AiOcrPassportResult = await api.ocrPassportAi(token, imageDataUrl);

    if (!aiRes.configured) {
      return { ...base, ...(await runLocalOcr(file, 'local', onProgress)) };
    }

    if (aiRes.suggested) {
      const s = aiRes.suggested;
      const patch: PassportOcrPatch = {
        ...base,
        ocrPct: 100,
        ocrStage: '识别完成',
        ocrEngine: 'ai',
        ocrModel: aiRes.model ?? null,
        reviewFields: aiRes.verify?.reviewFields ?? undefined,
        mrzValid: aiRes.verify?.mrzValid ?? null,
        localOcrCaveat: false,
      };
      if (s.fullName) patch.fullName = normalizePassengerFullName(s.fullName);
      if (s.documentNumber) patch.documentNumber = s.documentNumber;
      if (s.dateOfBirth) patch.dateOfBirth = s.dateOfBirth;
      if (s.gender) patch.gender = s.gender;
      if (s.chineseName) patch.chineseName = s.chineseName;
      if (s.passportIssueDate) patch.passportIssueDate = s.passportIssueDate;
      if (s.passportIssuePlace) patch.passportIssuePlace = s.passportIssuePlace;
      if (s.passportExpiry) patch.passportExpiry = s.passportExpiry;
      return patch;
    }

    // AI 配了但识别失败 → 回退本地
    return { ...base, ...(await runLocalOcr(file, 'ai-fallback', onProgress)) };
  } catch {
    // 网络/后端异常 → 回退本地
    return { ...base, ...(await runLocalOcr(file, 'ai-fallback', onProgress)) };
  }
}

/** OCR 校验字段名 → 中文标签（与 SingleOrderModal 同一份映射，供批量创单等其它入口复用）。 */
export const OCR_FIELD_LABELS: Record<string, string> = {
  fullName: '姓名',
  lastName: '姓',
  firstName: '名',
  chineseName: '中文姓名',
  documentNumber: '护照号',
  dateOfBirth: '出生日期',
  gender: '性别',
  nationality: '国籍',
  passportIssueCountry: '签发国',
  passportExpiry: '护照有效期',
  passportIssueDate: '护照签发日期',
  passportIssuePlace: '护照签发地点',
  placeOfBirth: '出生地',
};

/** 行下方紧凑提示文案；无需提示返回 null。 */
export function ocrReviewHintText(params: {
  reviewFields?: Array<{ field: string; reason: string }>;
  mrzValid?: boolean | null;
  localOcrCaveat?: boolean;
}): string | null {
  if (params.reviewFields && params.reviewFields.length > 0) {
    const prefix = params.mrzValid === false ? '护照机读区未能校验，请逐项核对：' : 'AI 识别建议人工核对：';
    const items = params.reviewFields.map((r) => `${OCR_FIELD_LABELS[r.field] ?? r.field}（${r.reason}）`);
    return `${prefix}${items.join('、')}`;
  }
  if (params.localOcrCaveat) {
    return '本地识别精度有限，请逐项核对';
  }
  return null;
}
