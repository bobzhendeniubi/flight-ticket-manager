/**
 * passportOcrRunner 单测——覆盖 AI 优先 / 未配置回退本地 / AI 失败回退本地 三条路径，
 * 以及行下方提示文案 ocrReviewHintText 的三种展示口径。
 *
 * `./api`（网络请求）与 `./passportOcr`（依赖浏览器 FileReader/canvas/Tesseract，Node 测试环境
 * 没有这些 DOM API）都整体 mock 掉——本文件只验证 runner 自身的编排逻辑（AI 优先/回退/字段映射），
 * 不重复测试已在别处覆盖的底层 OCR 实现。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runPassportOcr, ocrReviewHintText } from './passportOcrRunner';

const ocrPassportAiMock = vi.fn();
vi.mock('./api', () => ({
  api: {
    ocrPassportAi: (...args: unknown[]) => ocrPassportAiMock(...args),
  },
}));

const passportPhotoToDataUrlMock = vi.fn();
const ocrPassportMock = vi.fn();
vi.mock('./passportOcr', () => ({
  passportPhotoToDataUrl: (...args: unknown[]) => passportPhotoToDataUrlMock(...args),
  ocrPassport: (...args: unknown[]) => ocrPassportMock(...args),
}));

const dummyFile = {} as unknown as File;

describe('runPassportOcr', () => {
  beforeEach(() => {
    ocrPassportAiMock.mockReset();
    passportPhotoToDataUrlMock.mockReset();
    ocrPassportMock.mockReset();
    passportPhotoToDataUrlMock.mockResolvedValue('data:image/jpeg;base64,AAAA');
  });

  it('AI 已配置且识别成功 → 引擎标 ai，字段规范化回填', async () => {
    ocrPassportAiMock.mockResolvedValue({
      configured: true,
      engine: 'qwen',
      model: 'qwen-vl-plus',
      suggested: {
        fullName: 'zhang/san',
        documentNumber: 'E12345678',
        dateOfBirth: '1990-01-01',
        gender: 'M',
        chineseName: '张三',
        passportIssueDate: '2020-01-01',
        passportIssuePlace: '北京',
        passportExpiry: '2030-01-01',
      },
      verify: { mrzValid: true, reviewFields: [{ field: 'documentNumber', reason: '反光' }] },
    });

    const patch = await runPassportOcr('token-1', dummyFile);

    expect(patch.ocrEngine).toBe('ai');
    expect(patch.ocrModel).toBe('qwen-vl-plus');
    expect(patch.fullName).toBe('ZHANG/SAN'); // normalizePassengerFullName 规范化
    expect(patch.documentNumber).toBe('E12345678');
    expect(patch.dateOfBirth).toBe('1990-01-01');
    expect(patch.gender).toBe('M');
    expect(patch.chineseName).toBe('张三');
    expect(patch.passportIssueDate).toBe('2020-01-01');
    expect(patch.passportIssuePlace).toBe('北京');
    expect(patch.passportExpiry).toBe('2030-01-01');
    expect(patch.passportPhotoUrl).toBe('data:image/jpeg;base64,AAAA');
    expect(patch.mrzValid).toBe(true);
    expect(patch.reviewFields).toEqual([{ field: 'documentNumber', reason: '反光' }]);
    expect(ocrPassportMock).not.toHaveBeenCalled(); // AI 命中不应回退本地
  });

  it('AI 未配置 → 直接回退本地识别，引擎标 local', async () => {
    ocrPassportAiMock.mockResolvedValue({ configured: false });
    ocrPassportMock.mockResolvedValue({
      success: true,
      rawText: '',
      confidence: 80,
      elapsedMs: 100,
      suggested: { fullName: 'li si', passportNumber: 'E87654321', dateOfBirth: '1985-05-05', gender: 'F' },
    });

    const patch = await runPassportOcr('token-1', dummyFile);

    expect(patch.ocrEngine).toBe('local');
    expect(patch.fullName).toBe('LI SI');
    expect(patch.documentNumber).toBe('E87654321');
    expect(patch.localOcrCaveat).toBe(true);
    expect(patch.reviewFields).toBeUndefined();
  });

  it('AI 配置但识别失败（suggested 为 null）→ 回退本地，引擎标 ai-fallback', async () => {
    ocrPassportAiMock.mockResolvedValue({ configured: true, engine: 'qwen', model: 'qwen-vl-plus', suggested: null });
    ocrPassportMock.mockResolvedValue({
      success: false,
      rawText: '',
      confidence: 0,
      elapsedMs: 50,
      suggested: {},
    });

    const patch = await runPassportOcr('token-1', dummyFile);

    expect(patch.ocrEngine).toBe('ai-fallback');
    expect(patch.localOcrCaveat).toBe(true);
  });

  it('AI 请求异常 → 回退本地，引擎标 ai-fallback', async () => {
    ocrPassportAiMock.mockRejectedValue(new Error('network down'));
    ocrPassportMock.mockResolvedValue({
      success: true,
      rawText: '',
      confidence: 60,
      elapsedMs: 100,
      suggested: { fullName: 'wang wu' },
    });

    const patch = await runPassportOcr('token-1', dummyFile);

    expect(patch.ocrEngine).toBe('ai-fallback');
    expect(patch.fullName).toBe('WANG WU');
  });
});

describe('ocrReviewHintText', () => {
  it('无 reviewFields 也无 localOcrCaveat → 无提示', () => {
    expect(ocrReviewHintText({})).toBeNull();
  });

  it('有 reviewFields 且 mrzValid 非 false → AI 建议核对文案', () => {
    const hint = ocrReviewHintText({
      reviewFields: [{ field: 'documentNumber', reason: '反光' }],
      mrzValid: true,
    });
    expect(hint).toBe('AI 识别建议人工核对：护照号（反光）');
  });

  it('有 reviewFields 且 mrzValid === false → 机读区未校验文案', () => {
    const hint = ocrReviewHintText({
      reviewFields: [{ field: 'dateOfBirth', reason: '模糊' }],
      mrzValid: false,
    });
    expect(hint).toBe('护照机读区未能校验，请逐项核对：出生日期（模糊）');
  });

  it('无 reviewFields 但 localOcrCaveat=true → 本地识别精度提示', () => {
    expect(ocrReviewHintText({ localOcrCaveat: true })).toBe('本地识别精度有限，请逐项核对');
  });
});
