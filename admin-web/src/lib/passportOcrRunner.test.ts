/**
 * passportOcrRunner 单测：AI 成功、未配置、AI 返回失败、网络异常四条路径。
 *
 * `./api`（网络请求）与 `./passportOcr`（仅保留图片压缩导出）都 mock 掉；mock 模块不提供识别函数，
 * 用例因此也能确保 runner 不再加载浏览器本地识别实现。
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
vi.mock('./passportOcr', () => ({
  passportPhotoToDataUrl: (...args: unknown[]) => passportPhotoToDataUrlMock(...args),
}));

const dummyFile = {} as unknown as File;

function expectFailedWithoutPassengerFields(patch: Awaited<ReturnType<typeof runPassportOcr>>): void {
  expect(patch.ocrFailed).toBe(true);
  expect(patch.ocrEngine).toBeNull();
  expect(patch.fullName).toBeUndefined();
  expect(patch.documentNumber).toBeUndefined();
  expect(patch.dateOfBirth).toBeUndefined();
  expect(patch.gender).toBeUndefined();
  expect(patch.chineseName).toBeUndefined();
  expect(patch.passportIssueDate).toBeUndefined();
  expect(patch.passportIssuePlace).toBeUndefined();
  expect(patch.passportExpiry).toBeUndefined();
  expect(patch.passportPhotoUrl).toBe('data:image/jpeg;base64,AAAA');
}

describe('runPassportOcr', () => {
  beforeEach(() => {
    ocrPassportAiMock.mockReset();
    passportPhotoToDataUrlMock.mockReset();
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
    expect(patch.ocrFailed).toBe(false);
    expect(patch.ocrModel).toBe('qwen-vl-plus');
    expect(patch.fullName).toBe('ZHANG/SAN');
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
  });

  it('AI 未配置 → 明确报错，不回填字段', async () => {
    ocrPassportAiMock.mockResolvedValue({ configured: false });

    const patch = await runPassportOcr('token-1', dummyFile);

    expect(patch.ocrPct).toBeNull();
    expect(patch.ocrStage).toBe('AI 识别未配置：请在「设置 → AI 识别」配置密钥后重试');
    expectFailedWithoutPassengerFields(patch);
  });

  it('AI 返回 suggested 为 null → 使用后端错误明确报错，不回填字段', async () => {
    ocrPassportAiMock.mockResolvedValue({
      configured: true,
      engine: 'qwen',
      model: 'qwen-vl-plus',
      suggested: null,
      error: '图片无法识别',
    });

    const patch = await runPassportOcr('token-1', dummyFile);

    expect(patch.ocrPct).toBeNull();
    expect(patch.ocrStage).toBe('AI 识别失败：图片无法识别');
    expectFailedWithoutPassengerFields(patch);
  });

  it('AI 请求异常 → 明确网络服务错误，不回填字段', async () => {
    ocrPassportAiMock.mockRejectedValue(new Error('network down'));

    const patch = await runPassportOcr('token-1', dummyFile);

    expect(patch.ocrPct).toBeNull();
    expect(patch.ocrStage).toBe('AI 识别失败：网络或服务异常，请重试');
    expectFailedWithoutPassengerFields(patch);
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

  it('兼容旧 localOcrCaveat=true 的提示文案', () => {
    expect(ocrReviewHintText({ localOcrCaveat: true })).toBe('本地识别精度有限，请逐项核对');
  });
});
