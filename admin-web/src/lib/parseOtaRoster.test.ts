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

describe('散行乘客 · 未映射 3 位码误判国籍（0905 运营反馈：ZHOU/NIAO FEN 被截成 ZHOU/NIAO 且国籍误填 FEN）', () => {
  it('未映射 3 位纯字母 token（FEN）不算强国家 token，并入名字，真实国籍（中国大陆）被正确取到', () => {
    // Arrange
    const roster =
      'QH9588 DAD-MFM 2026-09-01\nZHOU/NIAO FEN 女 普通 护照 EN1403318 中国大陆 1979-03-13 2034-8-6';

    // Act
    const r = parseOtaRoster(roster);

    // Assert
    expect(r.passengers).toHaveLength(1);
    expect(r.passengers[0]).toMatchObject({
      fullName: 'ZHOU/NIAO FEN',
      lastName: 'ZHOU',
      firstName: 'NIAO FEN',
      gender: 'F',
      documentNumber: 'EN1403318',
      nationality: 'CN',
      dateOfBirth: '1979-03-13',
      passportExpiry: '2034-08-06',
    });
    expect(r.warnings.some((w) => w.includes('国籍码'))).toBe(false);
  });

  it('映射 3 位码（VNM）仍是强国家 token，正常识别为 VN', () => {
    // Arrange
    const roster = 'QH9588 DAD-MFM 2026-09-01\nZHANG/SAN 男 E12345678 VNM 1990-01-01 2030-01-01';

    // Act
    const r = parseOtaRoster(roster);

    // Assert
    expect(r.passengers).toHaveLength(1);
    expect(r.passengers[0]).toMatchObject({ fullName: 'ZHANG/SAN', nationality: 'VN' });
  });

  it('全篇只有未映射 3 位码、没有别的国籍证据时，保持原行为：回退取该码为国籍并提示核对', () => {
    // Arrange
    const roster = 'QH9588 DAD-MFM 2026-09-01\nLI/HUA 女 EA1234567 XYZ 1990-01-01 2030-01-01';

    // Act
    const r = parseOtaRoster(roster);

    // Assert
    expect(r.passengers).toHaveLength(1);
    expect(r.passengers[0]).toMatchObject({ fullName: 'LI/HUA', nationality: 'XYZ' });
    expect(
      r.warnings.some((w) => w.includes('国籍码「XYZ」为 3 位码且未匹配到已知映射，已按原样保留')),
    ).toBe(true);
  });

  it('裸 2 位字母（YU）不算强国家 token，并入名字；中文国名（中国大陆）仍被正确取到', () => {
    // Arrange
    const roster =
      'QH9588 DAD-MFM 2026-09-01\nWANG/XIAO YU 男 中国大陆 E12345678 1990-01-01 2030-01-01';

    // Act
    const r = parseOtaRoster(roster);

    // Assert
    expect(r.passengers).toHaveLength(1);
    expect(r.passengers[0]).toMatchObject({
      fullName: 'WANG/XIAO YU',
      lastName: 'WANG',
      firstName: 'XIAO YU',
      nationality: 'CN',
    });
  });
});

describe('结构化备注词（大床 / 双床 / 单住 / 自备签 / 单独编码）', () => {
  it('乘客之后的独立备注词行 → 归最近解析出的那位乘客，不再撒给全员', () => {
    // Arrange —— 编号单行式：两位乘客，末尾单独写一行「大床」
    const roster = [
      '1 TEST/DELTA 男 普通 护照 EA0000011 中国大陆 1990-01-02 2030-03-04',
      '2 TEST/DELTATWO 女 普通 护照 EA0000012 中国大陆 1992-05-06 2031-07-08',
      'QH9588 DAD MFM 2026-10-01',
      '大床',
    ].join('\n');

    // Act
    const r = parseOtaRoster(roster);

    // Assert —— 只落到最近的那一位（第一位不受影响）
    expect(r.passengers).toHaveLength(2);
    expect(r.passengers[0].bedPref).toBeUndefined();
    expect(r.passengers[1].bedPref).toBe('DOUBLE');
    expect(r.warnings).toContain('已按名单勾选：大床 ×1，请核对');
  });

  it('编号单行式：紧跟在某位乘客行下面的备注词行归那一位，不串到下一位', () => {
    // Arrange
    const roster = [
      'QH9588 DAD MFM 2026-10-01',
      '1 TEST/MIKE 男 普通 护照 EA0000031 中国大陆 1990-01-02 2030-03-04',
      '大床',
      '2 TEST/MIKETWO 女 普通 护照 EA0000032 中国大陆 1992-05-06 2031-07-08',
      '双床',
    ].join('\n');

    // Act
    const r = parseOtaRoster(roster);

    // Assert
    expect(r.passengers).toHaveLength(2);
    expect(r.passengers[0]).toMatchObject({ fullName: 'TEST/MIKE', bedPref: 'DOUBLE' });
    expect(r.passengers[1]).toMatchObject({ fullName: 'TEST/MIKETWO', bedPref: 'TWIN' });
    // 两位各写各的，不算冲突
    expect(r.warnings.some((w) => w.includes('床型写了两种'))).toBe(false);
  });

  it('表头区（第一位乘客之前）的备注词行 → 归全员', () => {
    // Arrange
    const roster = [
      'QH9588 DAD MFM 2026-10-01',
      '大床',
      '1 TEST/NOVEM 男 普通 护照 EA0000033 中国大陆 1990-01-02 2030-03-04',
      '2 TEST/NOVEMTWO 女 普通 护照 EA0000034 中国大陆 1992-05-06 2031-07-08',
    ].join('\n');

    // Act
    const r = parseOtaRoster(roster);

    // Assert
    expect(r.passengers).toHaveLength(2);
    expect(r.passengers.every((p) => p.bedPref === 'DOUBLE')).toBe(true);
    expect(r.warnings).toContain('已按名单勾选：大床 ×2，请核对');
  });

  it('表头区写了两种床型 → 保留第一处并提醒，不被后一处覆盖', () => {
    // Arrange
    const roster = [
      'QH9588 DAD MFM 2026-10-01',
      '大床',
      '双床',
      '1 TEST/OSCAR 男 普通 护照 EA0000035 中国大陆 1990-01-02 2030-03-04',
      '2 TEST/OSCARTWO 女 普通 护照 EA0000036 中国大陆 1992-05-06 2031-07-08',
    ].join('\n');

    // Act
    const r = parseOtaRoster(roster);

    // Assert —— 第一处（大床）胜出，两位都是大床，另发冲突提醒
    expect(r.passengers.every((p) => p.bedPref === 'DOUBLE')).toBe(true);
    expect(r.warnings).toContain('名单里床型写了两种（大床/双床），已按第一处勾选，请核对');
    expect(r.warnings).toContain('已按名单勾选：大床 ×2，请核对');
    expect(r.warnings.some((w) => w.includes('双床 ×'))).toBe(false);
  });

  it('同一位乘客被写了两种床型 → 同样保留第一处并提醒', () => {
    // Arrange
    const roster = [
      'QH9588 DAD MFM 2026-10-01',
      '1 TEST/PAPA 男 普通 护照 EA0000037 中国大陆 1990-01-02 2030-03-04',
      '大床',
      '双床',
    ].join('\n');

    // Act
    const r = parseOtaRoster(roster);

    // Assert
    expect(r.passengers[0].bedPref).toBe('DOUBLE');
    expect(r.warnings).toContain('名单里床型写了两种（大床/双床），已按第一处勾选，请核对');
  });

  it('单住 / 自备签整批勾给全员时，提醒必须点明「全部 N 位」（这两项动钱）', () => {
    // Arrange —— 表头区写「单住、自备签」，会落到全部 2 位
    const roster = [
      'QH9588 DAD MFM 2026-10-01',
      '单住、自备签',
      '1 TEST/QUEBEC 男 普通 护照 EA0000038 中国大陆 1990-01-02 2030-03-04',
      '2 TEST/QUEBECTWO 女 普通 护照 EA0000039 中国大陆 1992-05-06 2031-07-08',
    ].join('\n');

    // Act
    const r = parseOtaRoster(roster);

    // Assert
    expect(r.passengers.every((p) => p.singleRoom === true && p.visaExempt === true)).toBe(true);
    expect(r.warnings).toContain('已按名单给全部 2 位勾选：单住，请核对');
    expect(r.warnings).toContain('已按名单给全部 2 位勾选：自备签，请核对');
    // 逐人口径的「×N」写法不应同时出现，避免两种说法打架
    expect(r.warnings.some((w) => w.includes('单住 ×'))).toBe(false);
    expect(r.warnings.some((w) => w.includes('自备签 ×'))).toBe(false);
  });

  it('点名到某位的单住 / 自备签仍用「×N」口径，不说「全部」', () => {
    // Arrange
    const roster = [
      'QH9588 DAD MFM 2026-10-01',
      '1 TEST/ROMEO 男 普通 护照 EA0000040 中国大陆 1990-01-02 2030-03-04 自备签',
      '2 TEST/ROMEOTWO 女 普通 护照 EA0000041 中国大陆 1992-05-06 2031-07-08',
    ].join('\n');

    // Act
    const r = parseOtaRoster(roster);

    // Assert
    expect(r.passengers[0].visaExempt).toBe(true);
    expect(r.passengers[1].visaExempt).toBeUndefined();
    expect(r.warnings).toContain('已按名单勾选：自备签 ×1，请核对');
    expect(r.warnings.some((w) => w.includes('全部'))).toBe(false);
  });

  it('备注词混着其它文字（备注：单住 靠窗）→ 不勾选，按原文行号点名提醒', () => {
    // Arrange
    const roster = [
      'QH9588 DAD MFM 2026-10-01',
      '1 TEST/SIERRA 男 普通 护照 EA0000042 中国大陆 1990-01-02 2030-03-04',
      '备注：单住 靠窗',
    ].join('\n');

    // Act
    const r = parseOtaRoster(roster);

    // Assert
    expect(r.passengers[0].singleRoom).toBeUndefined();
    expect(r.warnings).toContain('第 3 行含「单住」但混有其它文字，未自动勾选，请手动核对');
    expect(r.warnings.some((w) => w.includes('已按名单勾选：单住'))).toBe(false);
  });

  it('混合写法的行号按原文算（空行不改变行号）', () => {
    // Arrange —— 第 2 行是空行，混合写法落在第 4 行
    const roster = [
      'QH9588 DAD MFM 2026-10-01',
      '',
      '1 TEST/TANGO 男 普通 护照 EA0000043 中国大陆 1990-01-02 2030-03-04',
      '大床 靠窗',
    ].join('\n');

    // Act
    const r = parseOtaRoster(roster);

    // Assert
    expect(r.warnings).toContain('第 4 行含「大床」但混有其它文字，未自动勾选，请手动核对');
  });

  it('乘客行末尾带备注词不算「混有其它文字」，照常落到本人', () => {
    // Arrange
    const roster = [
      'QH9588 DAD MFM 2026-10-01',
      '1 TEST/UNIFORM 男 普通 护照 EA0000044 中国大陆 1990-01-02 2030-03-04 大床',
    ].join('\n');

    // Act
    const r = parseOtaRoster(roster);

    // Assert
    expect(r.passengers[0].bedPref).toBe('DOUBLE');
    expect(r.warnings.some((w) => w.includes('混有其它文字'))).toBe(false);
  });

  it('双床 → TWIN', () => {
    const r = parseOtaRoster(
      'QH9588 DAD-MFM 2026-10-01\nTEST/ECHO 男 普通 EA0000013 中国大陆 1990-01-02 2030-03-04\n双床',
    );
    expect(r.passengers[0].bedPref).toBe('TWIN');
    expect(r.warnings).toContain('已按名单勾选：双床 ×1，请核对');
  });

  it('同一行同时写了大床与双床 → 取靠前的那个', () => {
    const r = parseOtaRoster(
      'QH9588 DAD-MFM 2026-10-01\nTEST/ECHOTWO 男 普通 EA0000014 中国大陆 1990-01-02 2030-03-04\n大床/双床',
    );
    expect(r.passengers[0].bedPref).toBe('DOUBLE');
  });

  it('单住 → singleRoom；自备签 / 自备签证 → visaExempt', () => {
    // Arrange
    const roster = [
      'QH9588 DAD-MFM 2026-10-01',
      'TEST/FOXTROT 女 普通 EA0000015 中国大陆 1988-02-03 2032-04-05',
      '单住、自备签证',
    ].join('\n');

    // Act
    const r = parseOtaRoster(roster);

    // Assert
    expect(r.passengers[0]).toMatchObject({ singleRoom: true, visaExempt: true });
    expect(r.warnings).toContain('已按名单勾选：单住 ×1，请核对');
    expect(r.warnings).toContain('已按名单勾选：自备签 ×1，请核对');
  });

  it('词写在乘客自己那一行（编号单行式）→ 只归这一位，另一位不受影响', () => {
    // Arrange
    const roster = [
      '1 TEST/GOLF 男 普通 护照 EA0000016 中国大陆 1990-01-02 2030-03-04 大床 单住',
      '2 TEST/GOLFTWO 女 普通 护照 EA0000017 中国大陆 1992-05-06 2031-07-08',
      'QH9588 DAD MFM 2026-10-01',
    ].join('\n');

    // Act
    const r = parseOtaRoster(roster);

    // Assert
    expect(r.passengers).toHaveLength(2);
    expect(r.passengers[0]).toMatchObject({ fullName: 'TEST/GOLF', bedPref: 'DOUBLE', singleRoom: true });
    expect(r.passengers[1].bedPref).toBeUndefined();
    expect(r.passengers[1].singleRoom).toBeUndefined();
    expect(r.warnings).toContain('已按名单勾选：大床 ×1，请核对');
  });

  it('词独立成行但处在某位乘客的段落内（冒号多行式）→ 归那一位，后一位不受影响', () => {
    // Arrange
    const roster = [
      'QH9589 MFM-DAD 2026-10-02',
      '乘机人：TEST/HOTEL',
      '性别：男',
      '出生年月：1985-10-30',
      '护照：EA0000018',
      '有效期：2033-02-16',
      '大床',
      '乘机人：TEST/HOTELTWO',
      '性别：女',
      '出生年月：1990-01-02',
      '护照：EA0000019',
      '有效期：2032-05-06',
    ].join('\n');

    // Act
    const r = parseOtaRoster(roster);

    // Assert
    expect(r.passengers).toHaveLength(2);
    expect(r.passengers[0]).toMatchObject({ fullName: 'TEST/HOTEL', bedPref: 'DOUBLE' });
    expect(r.passengers[1].bedPref).toBeUndefined();
  });

  it('带短标签的备注词行（房型：大床）同样识别', () => {
    const r = parseOtaRoster(
      'QH9588 DAD-MFM 2026-10-01\nTEST/INDIA 男 普通 EA0000020 中国大陆 1990-01-02 2030-03-04\n房型：大床',
    );
    expect(r.passengers[0].bedPref).toBe('DOUBLE');
  });

  it('单独编码 → 订单级 separatePnr，且仍照旧写进每位乘客备注', () => {
    // Arrange
    const roster = [
      '1 TEST/JULIET 男 普通 护照 EA0000021 中国大陆 1990-01-02 2030-03-04',
      '2 TEST/JULIETTWO 女 普通 护照 EA0000022 中国大陆 1992-05-06 2031-07-08',
      'QH9588 DAD MFM 2026-10-01',
      '单独编码',
    ].join('\n');

    // Act
    const r = parseOtaRoster(roster);

    // Assert
    expect(r.separatePnr).toBe(true);
    expect(r.passengers.every((p) => (p.note ?? '').includes('单独编码'))).toBe(true);
    expect(r.warnings).toContain('已按名单勾选：单独编码出票，请核对');
  });

  it('「价格 + 单独编码」同行：价格照常识别，separatePnr 同样置位', () => {
    const r = parseOtaRoster(
      '1 TEST/KILO 男 普通 护照 EA0000023 中国大陆 1990-01-02 2030-03-04\nQH9588 DAD MFM 2026-10-01\n1030 单独编码',
    );
    expect(r.settlementUnitPriceCny).toBe(1030);
    expect(r.separatePnr).toBe(true);
  });

  it('名单里没有这些词时不置任何字段、不发「已按名单勾选」提醒', () => {
    const r = parseOtaRoster(
      'QH9588 DAD-MFM 2026-10-01\nTEST/LIMA 男 普通 EA0000024 中国大陆 1990-01-02 2030-03-04',
    );
    expect(r.separatePnr).toBeUndefined();
    expect(r.passengers[0].bedPref).toBeUndefined();
    expect(r.passengers[0].singleRoom).toBeUndefined();
    expect(r.passengers[0].visaExempt).toBeUndefined();
    expect(r.warnings.some((w) => w.includes('已按名单勾选'))).toBe(false);
  });
});
