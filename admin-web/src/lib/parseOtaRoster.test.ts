/**
 * parseOtaRoster · 三种名单格式回归（全部使用合成数据，不含任何真实姓名/护照号）。
 *
 * 覆盖：
 *   1. 冒号多行 · 年-月-日（COLON_MULTILINE_YMD 样式）：全角冒号 + 970*2 价格行 + 单独编码
 *   2. 编号单行（INLINE_NUMBERED 样式）：行首序号 + 空格分隔航段 + 「1030  单独编码」同行价格+编码
 *   3. 冒号多行 · 日-月-年（COLON_MULTILINE_DMY 样式）：半角冒号 + CHN 三位码 + 结算价带 CNY 后缀
 *      + dateOrder:'DMY' 传参（含歧义日期 05-06-1987 不再追加「请核对」提醒）
 */
import { describe, it, expect } from 'vitest';
import { parseOtaRoster } from './parseOtaRoster';

const ROSTER_COLON_YMD = `QH9589 MFM-DAD 2026-07-27
乘机人：TEST/ALPHA
性别：男
出生年月：1985-10-30
护照：EJ0000001
签发国：CN
有效期：2033-02-16
乘机人：TEST/ALPHATWO
性别：女
出生年月：1990-01-02
护照：EJ0000009
签发国：CN
有效期：2032-05-06
970*2
单独编码`;

const ROSTER_INLINE_NUMBERED = `1 TEST/BETA 男 普通 护照 EE0000002 中国大陆 1999-08-04 2028-11-25
2 TEST/BETATWO 女 普通 护照 EE0000008 中国大陆 2001-12-01 2029-01-15
QH9588 DAD MFM 2026-7-25
1030  单独编码`;

const ROSTER_COLON_DMY = `乘机人: TEST/GAMMA
性别: M
出生年月: 16-06-1987
护照: EN0000003
签发国: CHN
有效期: 19-09-2034
结算价:1020CNY`;

describe('冒号多行 · 年-月-日', () => {
  const r = parseOtaRoster(ROSTER_COLON_YMD);

  it('航段：QH9589 MFM→DAD 2026-07-27', () => {
    expect(r.flight).toMatchObject({
      flightNumber: 'QH9589',
      origin: 'MFM',
      destination: 'DAD',
      departDate: '2026-07-27',
    });
  });

  it('两名乘客，字段齐全', () => {
    expect(r.passengers).toHaveLength(2);
    expect(r.passengers[0]).toMatchObject({
      fullName: 'TEST/ALPHA',
      gender: 'M',
      dateOfBirth: '1985-10-30',
      documentNumber: 'EJ0000001',
      passportIssueCountry: 'CN',
      passportExpiry: '2033-02-16',
    });
    expect(r.passengers[1]).toMatchObject({
      fullName: 'TEST/ALPHATWO',
      gender: 'F',
      dateOfBirth: '1990-01-02',
    });
  });

  it('「970*2」按结算价 970 ×2 个识别，与乘客数一致', () => {
    expect(r.settlementUnitPriceCny).toBe(970);
    expect(r.settlementCount).toBe(2);
    expect(r.warnings.some((w) => w.includes('不一致'))).toBe(false);
  });

  it('「单独编码」写入每位乘客备注；命中格式 = COLON_MULTILINE', () => {
    expect(r.passengers[0].note).toContain('单独编码');
    expect(r.passengers[1].note).toContain('单独编码');
    expect(r.passengerFormat).toBe('COLON_MULTILINE');
  });
});

describe('编号单行', () => {
  const r = parseOtaRoster(ROSTER_INLINE_NUMBERED);

  it('行首序号被剥掉，两名乘客字段齐全（中国大陆 → CN）', () => {
    expect(r.passengers).toHaveLength(2);
    expect(r.passengers[0]).toMatchObject({
      fullName: 'TEST/BETA',
      gender: 'M',
      documentNumber: 'EE0000002',
      nationality: 'CN',
      dateOfBirth: '1999-08-04',
      passportExpiry: '2028-11-25',
    });
    expect(r.passengers[1]).toMatchObject({ fullName: 'TEST/BETATWO', gender: 'F' });
  });

  it('空格分隔航段：QH9588 DAD→MFM 2026-07-25', () => {
    expect(r.flight).toMatchObject({
      flightNumber: 'QH9588',
      origin: 'DAD',
      destination: 'MFM',
      departDate: '2026-07-25',
    });
  });

  it('「1030  单独编码」同行拆出价格 1030 + 编码备注；命中格式 = INLINE_NUMBERED', () => {
    expect(r.settlementUnitPriceCny).toBe(1030);
    expect(r.passengers[0].note).toContain('单独编码');
    expect(r.passengerFormat).toBe('INLINE_NUMBERED');
  });
});

describe('冒号多行 · 日-月-年（dateOrder: DMY）', () => {
  const r = parseOtaRoster(ROSTER_COLON_DMY, { dateOrder: 'DMY' });

  it('半角冒号 + 日-月-年日期：16-06-1987 → 1987-06-16，19-09-2034 → 2034-09-19', () => {
    expect(r.passengers).toHaveLength(1);
    expect(r.passengers[0]).toMatchObject({
      fullName: 'TEST/GAMMA',
      gender: 'M',
      dateOfBirth: '1987-06-16',
      documentNumber: 'EN0000003',
      passportExpiry: '2034-09-19',
    });
  });

  it('CHN 三位码归一为 CN，且不追加「未匹配映射」提醒', () => {
    expect(r.passengers[0].passportIssueCountry).toBe('CN');
    expect(r.warnings.some((w) => w.includes('未匹配到已知映射'))).toBe(false);
  });

  it('「结算价:1020CNY」识别为 1020；命中格式 = COLON_MULTILINE', () => {
    expect(r.settlementUnitPriceCny).toBe(1020);
    expect(r.passengerFormat).toBe('COLON_MULTILINE');
  });

  it('歧义日期 05-06-1987：DMY 传参 → 1987-06-05 且无「请核对」提醒；不传参 → 同解析但有提醒', () => {
    const ambiguous = ROSTER_COLON_DMY.replace('16-06-1987', '05-06-1987');
    const withDmy = parseOtaRoster(ambiguous, { dateOrder: 'DMY' });
    expect(withDmy.passengers[0].dateOfBirth).toBe('1987-06-05');
    expect(withDmy.warnings.some((w) => w.includes('歧义'))).toBe(false);

    const withoutOpts = parseOtaRoster(ambiguous);
    expect(withoutOpts.passengers[0].dateOfBirth).toBe('1987-06-05');
    expect(withoutOpts.warnings.some((w) => w.includes('歧义'))).toBe(true);
  });
});

describe('散行乘客 · 多词名（0831 公测反馈：LAM/MENG IEONG 被截成 LAM/MENG）', () => {
  it('名后的纯字母 token 并入名，性别/证件/日期照常识别', () => {
    const r = parseOtaRoster(
      'QH9588 DAD-MFM 2026-09-01\nLAM/MENG IEONG M 普通 MC1234567 中国澳门 1988-05-02 2030-01-15',
    );
    expect(r.passengers).toHaveLength(1);
    expect(r.passengers[0]).toMatchObject({
      fullName: 'LAM/MENG IEONG',
      lastName: 'LAM',
      firstName: 'MENG IEONG',
      gender: 'M',
      documentNumber: 'MC1234567',
    });
  });

  it('称谓 MR 不并入名；单词名行为不变', () => {
    const r = parseOtaRoster(
      'QH9588 DAD-MFM 2026-09-01\nFANG/BIN MR M 普通 EM9441432 中国大陆 1983-11-25 2034-07-08',
    );
    expect(r.passengers).toHaveLength(1);
    expect(r.passengers[0]).toMatchObject({ fullName: 'FANG/BIN', gender: 'M' });
  });
});
