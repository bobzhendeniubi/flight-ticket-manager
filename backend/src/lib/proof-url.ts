/**
 * 凭证图片 / 收款码 data-URL 校验（统一口径）。
 *
 * 沿用人工确认收款上传截图的 6MB 上限（payments.routes 里 `z.string().max(6_000_000)`），
 * 抽到这里复用，避免各处魔法数字漂移。两种用法：
 *
 *   proofUrlSchema      —— 截图凭证：仅卡 6MB 上限（与既有 manual-confirm 完全一致，不加前缀约束，
 *                          兼容历史/外部来源的非 data-URL）。
 *   dataUrlImageSchema  —— 收款码图片：6MB 上限 + 必须是 data:image/... 的 data-URL（更严，
 *                          收款渠道二维码只接受 base64 图片）。
 */
import { z } from 'zod';

/** 凭证 data URL 最大字节数（≈6MB，含 base64 膨胀）。沿用既有 manual-confirm 上限。 */
export const MAX_PROOF_URL_BYTES = 6_000_000;

/** 截图凭证：仅 6MB 上限（口径同既有人工确认收款）。 */
export const proofUrlSchema = z.string().max(MAX_PROOF_URL_BYTES, '凭证图片过大（上限约 6MB）');

/** 收款码 / 二维码图片：6MB 上限 + 必须为 data:image/... data-URL。 */
export const dataUrlImageSchema = z
  .string()
  .max(MAX_PROOF_URL_BYTES, '图片过大（上限约 6MB）')
  .refine((v) => /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(v), {
    message: '收款码必须是 data:image/...;base64 的图片 data-URL',
  });
