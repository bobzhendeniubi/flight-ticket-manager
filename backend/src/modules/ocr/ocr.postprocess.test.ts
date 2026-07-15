import { describe, it, expect } from 'vitest';
import { applyOcrPostProcessing } from './ocr.postprocess.js';

// ICAO Doc 9303 官方 TD3 样例（机读区校验位全通过）。
const MRZ_LINE1 = 'P<UTOERIKSSON<<ANNA<MARIA'.padEnd(44, '<');
const MRZ_LINE2 = 'L898902C36UTO7408122F1204159ZE184226B<<<<<10';

describe('applyOcrPostProcessing — MRZ 校验通过', () => {
  it('目视区出生日期与机读区不一致时取机读区值，并标记该字段需复核', () => {
    // 模拟护照反光导致目视区出生日期被误读（机读区 1974-08-12 才是真值）
    const result = applyOcrPostProcessing({
      lastName: 'ERIKSSON',
      firstName: 'ANNA MARIA',
      dateOfBirth: '1985-06-13', // 误读值
      gender: 'F',
      documentNumber: 'L898902C3',
      nationality: 'UTO',
      passportExpiry: '2012-04-15',
      mrzLine1: MRZ_LINE1,
      mrzLine2: MRZ_LINE2,
    });

    expect(result.verify.mrzValid).toBe(true);
    // 机读区取值覆盖误读
    expect(result.suggested.dateOfBirth).toBe('1974-08-12');
    // 该字段进入 reviewFields
    const dobReview = result.verify.reviewFields.find(
      (r) => r.field === 'dateOfBirth',
    );
    expect(dobReview).toBeDefined();
    expect(dobReview!.reason).toContain('机读区');
  });

  it('姓名 compose 为 LAST/FIRST，机读字段一致时不进 review', () => {
    const result = applyOcrPostProcessing({
      lastName: 'ERIKSSON',
      firstName: 'ANNA MARIA',
      dateOfBirth: '1974-08-12',
      gender: 'F',
      documentNumber: 'L898902C3',
      nationality: 'UTO',
      passportExpiry: '2012-04-15',
      mrzLine1: MRZ_LINE1,
      mrzLine2: MRZ_LINE2,
    });

    expect(result.suggested.fullName).toBe('ERIKSSON/ANNA MARIA');
    // 全部一致 → 机读字段无 review
    const mrzFieldReviews = result.verify.reviewFields.filter((r) =>
      ['documentNumber', 'dateOfBirth', 'passportExpiry', 'gender', 'nationality'].includes(
        r.field,
      ),
    );
    expect(mrzFieldReviews).toHaveLength(0);
  });
});

describe('applyOcrPostProcessing — MRZ 缺失/不过', () => {
  it('无 MRZ 行时全部机读字段进 review 且保留 LLM 值', () => {
    const result = applyOcrPostProcessing({
      lastName: 'QU',
      firstName: 'DAPENG',
      documentNumber: 'E12345678',
      dateOfBirth: '1990-01-01',
      gender: 'M',
      nationality: 'CHN',
      passportExpiry: '2030-01-01',
    });

    expect(result.verify.mrzValid).toBe(false);
    const fields = result.verify.reviewFields.map((r) => r.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        'documentNumber',
        'dateOfBirth',
        'passportExpiry',
        'gender',
        'nationality',
      ]),
    );
    // LLM 值保留
    expect(result.suggested.documentNumber).toBe('E12345678');
    expect(result.suggested.fullName).toBe('QU/DAPENG');
  });

  it('MRZ 校验位不过（篡改）时按缺失处理', () => {
    const tampered = 'L898902C4' + MRZ_LINE2.slice(9);
    const result = applyOcrPostProcessing({
      documentNumber: 'L898902C3',
      mrzLine1: MRZ_LINE1,
      mrzLine2: tampered,
    });
    expect(result.verify.mrzValid).toBe(false);
    expect(
      result.verify.reviewFields.some((r) => r.field === 'documentNumber'),
    ).toBe(true);
  });
});

describe('applyOcrPostProcessing — 非 MRZ 字段置信度', () => {
  it('置信度 < 98 的非 MRZ 字段进 review', () => {
    const result = applyOcrPostProcessing({
      chineseName: '郑沁沁',
      passportIssuePlace: '广东省广州市',
      mrzLine1: MRZ_LINE1,
      mrzLine2: MRZ_LINE2,
      fieldConfidence: { chineseName: 80, passportIssuePlace: 99 },
    });

    const lowConf = result.verify.reviewFields.find(
      (r) => r.field === 'chineseName',
    );
    expect(lowConf).toBeDefined();
    expect(lowConf!.reason).toContain('置信度');
    // 置信度 99 → 不进 review
    expect(
      result.verify.reviewFields.some((r) => r.field === 'passportIssuePlace'),
    ).toBe(false);
  });

  it('缺失置信度视为不足 → 进 review（有值时）', () => {
    const result = applyOcrPostProcessing({
      placeOfBirth: '北京',
      mrzLine1: MRZ_LINE1,
      mrzLine2: MRZ_LINE2,
    });
    expect(
      result.verify.reviewFields.some((r) => r.field === 'placeOfBirth'),
    ).toBe(true);
  });
});

describe('applyOcrPostProcessing — 向后兼容 suggested 形状', () => {
  it('suggested 始终包含原 13 键', () => {
    const result = applyOcrPostProcessing({});
    expect(Object.keys(result.suggested).sort()).toEqual(
      [
        'chineseName',
        'dateOfBirth',
        'documentNumber',
        'firstName',
        'fullName',
        'gender',
        'lastName',
        'nationality',
        'passportExpiry',
        'passportIssueCountry',
        'passportIssueDate',
        'passportIssuePlace',
        'placeOfBirth',
      ].sort(),
    );
  });
});
