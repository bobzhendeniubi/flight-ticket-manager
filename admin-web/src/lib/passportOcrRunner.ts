/**
 * 护照 OCR 识别 —— 共享 runner（供批量创单等录单入口复用）。
 *
 * 识别只走后端 AI：成功时返回 AI 结果；未登录、未配置、识别失败或请求异常时返回明确的失败状态，
 * 不回填乘客字段。图片仍会先压缩为存库图，方便运营人工核录。
 *
 * 注意：这里只做识别 + 结果整形，不碰任何 UI 状态——调用方自行决定如何落到自己的行状态里。
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
  /** true = 本次识别失败，调用方可据此标红提示 */
  ocrFailed?: boolean;
  ocrModel?: string | null;
  /** AI 识别时需人工核对的字段（后端 verify.reviewFields 透传） */
  reviewFields?: Array<{ field: string; reason: string }>;
  /** 护照 MRZ 校验是否通过；由 AI verify 返回 */
  mrzValid?: boolean | null;
  /** 兼容旧调用方的提示字段；当前 AI-only 识别流程不会置为 true */
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

/**
 * 识别一张护照图片：先压缩出存库图，再走后端 AI 识别，返回可直接 patch 到行状态的结果。
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

  // ── 2. 无 token（不应出现，保险兜底）→ 明确报错 ──
  if (!token) {
    return {
      ...base,
      ocrPct: null,
      ocrStage: '登录态缺失，无法识别，请重新登录',
      ocrEngine: null,
      ocrFailed: true,
    };
  }

  // ── 3. 尝试 AI 识别 ──
  try {
    onProgress?.(20, 'AI 识别中…');
    const imageDataUrl = dataUrl || (await fileToDataUrl(file));
    const aiRes: AiOcrPassportResult = await api.ocrPassportAi(token, imageDataUrl);

    if (!aiRes.configured) {
      return {
        ...base,
        ocrPct: null,
        ocrStage: 'AI 识别未配置：请在「设置 → AI 识别」配置密钥后重试',
        ocrEngine: null,
        ocrFailed: true,
      };
    }

    if (aiRes.suggested) {
      const s = aiRes.suggested;
      const patch: PassportOcrPatch = {
        ...base,
        ocrPct: 100,
        ocrStage: '识别完成',
        ocrEngine: 'ai',
        ocrFailed: false,
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

    return {
      ...base,
      ocrPct: null,
      ocrStage: `AI 识别失败：${aiRes.error ?? '请重试或手动填写'}`,
      ocrEngine: null,
      ocrFailed: true,
    };
  } catch {
    return {
      ...base,
      ocrPct: null,
      ocrStage: 'AI 识别失败：网络或服务异常，请重试',
      ocrEngine: null,
      ocrFailed: true,
    };
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
