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
      passportIssuePlace: '广东',
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

  it('fieldConfidence 只给了部分非 MRZ 键时，缺键且有值的字段仍进 review', () => {
    const result = applyOcrPostProcessing({
      chineseName: '测试样本',
      passportIssueDate: '2020-01-02',
      passportIssuePlace: '广东',
      mrzLine1: MRZ_LINE1,
      mrzLine2: MRZ_LINE2,
      fieldConfidence: { chineseName: 100, passportIssueDate: 100, placeOfBirth: 100 },
    });
    const nonMrzReviews = result.verify.reviewFields.filter((r) =>
      ['chineseName', 'passportIssueDate', 'passportIssuePlace', 'placeOfBirth'].includes(r.field),
    );
    expect(nonMrzReviews).toEqual([
      { field: 'passportIssuePlace', reason: '识别置信度不足，请人工核对' },
    ]);
  });
});

describe('applyOcrPostProcessing — fieldConfidence 只含非 MRZ 键（新提示词的输出形状）', () => {
  const CONF_4_KEYS = {
    chineseName: 100,
    passportIssueDate: 100,
    passportIssuePlace: 100,
    placeOfBirth: 100,
  };
  const NON_MRZ_VALUES = {
    chineseName: '测试样本',
    passportIssueDate: '2020-01-02',
    passportIssuePlace: '广东',
    placeOfBirth: '广东',
  };

  it('MRZ 校验通过且与目视区一致 → 无任何 review（机读字段不需要置信度）', () => {
    const result = applyOcrPostProcessing({
      lastName: 'ERIKSSON',
      firstName: 'ANNA MARIA',
      dateOfBirth: '1974-08-12',
      gender: 'F',
      documentNumber: 'L898902C3',
      nationality: 'UTO',
      passportExpiry: '2012-04-15',
      ...NON_MRZ_VALUES,
      mrzLine1: MRZ_LINE1,
      mrzLine2: MRZ_LINE2,
      fieldConfidence: CONF_4_KEYS,
    });
    expect(result.verify.mrzValid).toBe(true);
    expect(result.verify.reviewFields).toEqual([]);
  });

  it('MRZ 缺失 → 仍是 5 个机读字段逐项核对，与置信度无关', () => {
    const result = applyOcrPostProcessing({
      documentNumber: 'E12345678',
      dateOfBirth: '1990-01-01',
      gender: 'M',
      nationality: 'CHN',
      passportExpiry: '2030-01-01',
      ...NON_MRZ_VALUES,
      fieldConfidence: CONF_4_KEYS,
    });
    expect(result.verify.mrzValid).toBe(false);
    expect(result.verify.reviewFields).toEqual(
      ['documentNumber', 'dateOfBirth', 'passportExpiry', 'gender', 'nationality'].map(
        (field) => ({ field, reason: '机读区未能校验，请逐项人工核对' }),
      ),
    );
  });
});

describe('applyOcrPostProcessing — 签发地点兜底', () => {
  // MRZ 校验通过且目视区一致：reviewFields 里只会剩签发地点相关的条目，便于逐条断言。
  const CLEAN_INPUT = {
    lastName: 'ERIKSSON',
    firstName: 'ANNA MARIA',
    dateOfBirth: '1974-08-12',
    gender: 'F',
    documentNumber: 'L898902C3',
    nationality: 'UTO',
    passportExpiry: '2012-04-15',
    mrzLine1: MRZ_LINE1,
    mrzLine2: MRZ_LINE2,
  };
  const run = (passportIssuePlace: string | null | undefined, confidence = 100) =>
    applyOcrPostProcessing({
      ...CLEAN_INPUT,
      passportIssuePlace,
      fieldConfidence: { passportIssuePlace: confidence },
    });
  const issuePlaceReviews = (result: ReturnType<typeof applyOcrPostProcessing>) =>
    result.verify.reviewFields.filter((r) => r.field === 'passportIssuePlace');

  it.each([
    '中华人民共和国国家移民管理局',
    '国家移民管理局',
    '公安部出入境管理局',
    'Exit & Entry Administration, Ministry of Public Security',
    'National Immigration Administration, PRC',
    'MINISTRY OF FOREIGN AFFAIRS',
    '中华人民共和国驻胡志明市总领事馆',
  ])('签发机关「%s」→ 不填入，并提示照签发地点栏手填', (value) => {
    const result = run(value);
    expect(result.suggested.passportIssuePlace).toBeNull();
    const reviews = issuePlaceReviews(result);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].reason).toContain('签发机关');
  });

  it.each(['广东省广州市', '江西省南昌市', '北京市朝阳区', '广西壮族自治区南宁市'])(
    '多级地名「%s」→ 保留原值，但提示核对',
    (value) => {
      const result = run(value);
      expect(result.suggested.passportIssuePlace).toBe(value);
      const reviews = issuePlaceReviews(result);
      expect(reviews).toHaveLength(1);
      expect(reviews[0].reason).toContain('只印省份');
    },
  );

  it('多级地名且置信度也低 → 只给一条最具体的原因，不叠加', () => {
    const reviews = issuePlaceReviews(run('广东省广州市', 50));
    expect(reviews).toHaveLength(1);
    expect(reviews[0].reason).toContain('只印省份');
  });

  it.each(['江西', '广东', '内蒙古', '广东省', '北京市', '公安县'])(
    '正常省份 / 单级写法「%s」→ 原样保留，不提示',
    (value) => {
      const result = run(value);
      expect(result.suggested.passportIssuePlace).toBe(value);
      expect(issuePlaceReviews(result)).toEqual([]);
    },
  );

  it('正常省份但置信度不足 → 照旧按置信度提示', () => {
    const result = run('江西', 90);
    expect(result.suggested.passportIssuePlace).toBe('江西');
    expect(issuePlaceReviews(result)).toEqual([
      { field: 'passportIssuePlace', reason: '识别置信度不足，请人工核对' },
    ]);
  });

  it.each([
    ['广东/GUANGDONG', '广东'],
    ['江西 / JIANGXI', '江西'],
    ['内蒙古／NEI MONGOL', '内蒙古'],
  ])('斜杠原文「%s」→ 取斜杠前中文「%s」，不提示', (value, expected) => {
    const result = run(value);
    expect(result.suggested.passportIssuePlace).toBe(expected);
    expect(issuePlaceReviews(result)).toEqual([]);
  });

  it.each([null, undefined, '', '   '])('空值（%j）→ null，且不提示', (value) => {
    const result = applyOcrPostProcessing({ ...CLEAN_INPUT, passportIssuePlace: value });
    expect(result.suggested.passportIssuePlace).toBeNull();
    expect(issuePlaceReviews(result)).toEqual([]);
  });

  it('签发地点规则不影响机读字段：MRZ 仍校验通过，也不多出机读字段的提示', () => {
    const result = run('公安部出入境管理局');
    expect(result.verify.mrzValid).toBe(true);
    expect(result.suggested.documentNumber).toBe('L898902C3');
    expect(result.verify.reviewFields.map((r) => r.field)).toEqual(['passportIssuePlace']);
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

// 机读区第 1 行（姓名）没有校验位：parseTd3Mrz 会把尾部填充符数错 1-3 个的第 1 行补齐 / 截断，
// 但「姓名里漏抄一个字母」行尾同样是 '<'，补齐后长得完全合法——姓名必须提示核对，不能静默采用。
describe('applyOcrPostProcessing — 机读区姓名没有校验位', () => {
  const BASE = {
    dateOfBirth: '1974-08-12',
    gender: 'F',
    documentNumber: 'L898902C3',
    nationality: 'UTO',
    passportExpiry: '2012-04-15',
    mrzLine2: MRZ_LINE2,
  };

  it('第 1 行补齐过（名字漏抄一个字母）→ 姓、名都标黄，姓名取目视区，第 2 行照常校验', () => {
    const result = applyOcrPostProcessing({
      ...BASE,
      lastName: 'ERIKSSON',
      firstName: 'ANNA MARIA',
      mrzLine1: 'P<UTOERIKSSON<<ANNA<MARI'.padEnd(43, '<'),
    });
    expect(result.verify.mrzValid).toBe(true);
    expect(result.suggested.firstName).toBe('ANNA MARIA');
    const fields = result.verify.reviewFields.map((r) => r.field);
    expect(fields).toEqual(expect.arrayContaining(['lastName', 'firstName']));
    expect(fields).not.toContain('documentNumber');
    expect(result.verify.reviewFields.find((r) => r.field === 'firstName')!.reason).toContain('姓名');
  });

  it('第 1 行长度正确但目视区姓名与机读区字母不一致 → 该字段标黄', () => {
    const result = applyOcrPostProcessing({
      ...BASE,
      lastName: 'ERIKSSON',
      firstName: 'ANNA MARTA',
      mrzLine1: MRZ_LINE1,
    });
    expect(result.verify.reviewFields.map((r) => r.field)).toEqual(['firstName']);
  });

  it('只差空格 / 连字符 / 逗号 → 不标黄', () => {
    const result = applyOcrPostProcessing({
      ...BASE,
      lastName: 'ERIKSSON,',
      firstName: 'ANNA-MARIA',
      mrzLine1: MRZ_LINE1,
    });
    expect(result.verify.reviewFields).toEqual([]);
  });

  it('目视区给的是中文（没有拉丁字母）→ 不拿来比', () => {
    const result = applyOcrPostProcessing({
      ...BASE,
      lastName: '埃里克松',
      firstName: '安娜',
      mrzLine1: MRZ_LINE1,
    });
    expect(result.verify.reviewFields).toEqual([]);
  });
});

describe('applyOcrPostProcessing — 签发地点兜底（繁体机关名）', () => {
  it.each(['香港特別行政區入境事務處', '中華人民共和國駐溫哥華總領事館', '駐某國大使館'])(
    '%s → 不填入并提示手填',
    (place) => {
      const result = applyOcrPostProcessing({ passportIssuePlace: place });
      expect(result.suggested.passportIssuePlace).toBeNull();
      expect(result.verify.reviewFields.find((r) => r.field === 'passportIssuePlace')!.reason).toContain(
        '签发机关',
      );
    },
  );
});
