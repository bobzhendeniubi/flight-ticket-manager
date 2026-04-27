#!/usr/bin/env node
/**
 * Standalone smoke test for the passport OCR parser logic.
 *
 * 测试我们的 MRZ 解析 + fallback 正则是不是对，不依赖真实 tesseract（OCR 质量另说）。
 * 用 ICAO 9303 文档里的标准样例 + 几个 OCR 噪音版本。
 *
 * 运行: node scripts/test-passport-ocr.mjs
 */

// 复制粘贴 src/lib/passportOcr.ts 里的 parseMRZ + extractFallback
// （这个 mjs 不能直接 import .ts，所以拷贝逻辑做隔离测试）

function yymmddToIso(yymmdd, isBirth) {
  if (yymmdd.length !== 6 || !/^\d{6}$/.test(yymmdd)) return '';
  const yy = Number(yymmdd.substring(0, 2));
  const mm = yymmdd.substring(2, 4);
  const dd = yymmdd.substring(4, 6);
  const now = new Date().getFullYear() % 100;
  let year;
  if (isBirth) {
    year = yy > now + 5 ? 1900 + yy : 2000 + yy;
  } else {
    year = 2000 + yy;
  }
  return `${year}-${mm}-${dd}`;
}

function parseMRZ(text) {
  const normalized = text
    .replace(/[«‹«‹]/g, '<')
    .replace(/[≤≦]/g, '<');

  const lines = normalized.split(/\r?\n/).map((l) => l.trim());

  for (let i = 0; i < lines.length - 1; i++) {
    const l1 = lines[i].replace(/\s/g, '');
    const l2 = lines[i + 1].replace(/\s/g, '');
    if (l1.length < 30 || l2.length < 30) continue;

    const hasFiller = /<{3,}/.test(l1) || /<{3,}/.test(l2);
    if (!hasFiller) continue;

    if (!/^[A-Z0-9<]{9}/.test(l2)) continue;

    try {
      const after = l1.substring(5);
      const [surnameRaw, ...givenRawParts] = after.split(/<<+/);
      const surname = (surnameRaw ?? '').replace(/</g, ' ').trim();
      const givenNames = givenRawParts
        .join(' ')
        .replace(/</g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const passportNumber = l2.substring(0, 9).replace(/</g, '').trim();
      const nationality = l2.substring(10, 13);
      const dobRaw = l2.substring(13, 19);
      const sex = (l2.substring(20, 21) || 'X');
      const expiryRaw = l2.substring(21, 27);

      if (passportNumber.length < 5) continue;

      return {
        surname,
        givenNames,
        passportNumber,
        nationality,
        dateOfBirth: yymmddToIso(dobRaw, true),
        sex,
        expiryDate: yymmddToIso(expiryRaw, false),
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

function extractFallback(text) {
  const result = {};
  const cleaned = text
    .replace(/[OQ](?=\d)/g, '0')
    .replace(/(?<=\d)[OQ]/g, '0')
    .replace(/[Il](?=\d)/g, '1');

  let passportMatch = cleaned.match(/\b[EGSDPH][A-Z]?\d{7,8}\b/);
  if (!passportMatch) {
    const isoCountryAndNumber = cleaned.match(/\b[A-Z]{3}(\d{6,9})\b/);
    if (isoCountryAndNumber) {
      result.passportNumber = isoCountryAndNumber[1];
    } else {
      passportMatch = cleaned.match(/\b[A-Z]{1,2}\d{6,9}\b/);
    }
  }
  if (!passportMatch && !result.passportNumber) {
    passportMatch = cleaned.match(/(?<![A-Z\d])\d{7,9}(?![A-Z\d])/);
  }
  if (passportMatch && !result.passportNumber) result.passportNumber = passportMatch[0];

  const stopWords = new Set([
    'PASSPORT', 'UNITED', 'KINGDOM', 'STATES', 'AMERICA', 'REPUBLIC',
    'PEOPLE', 'CHINA', 'JAPAN', 'KOREA', 'VIETNAM', 'NATIONALITY',
    'SURNAME', 'GIVEN', 'NAME', 'NAMES', 'BIRTH', 'DATE', 'PLACE',
    'EXPIRY', 'AUTHORITY', 'SEX', 'TYPE', 'CODE', 'NUMBER',
    'NO', 'OF', 'MALE', 'FEMALE',
  ]);
  const englishNameCandidates = text.match(/[A-Z]{2,}[,\s]+[A-Z]{2,}(?:[,\s]+[A-Z]{2,})*/g) ?? [];
  for (const cand of englishNameCandidates) {
    const tokens = cand.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
    if (tokens.every((t) => !stopWords.has(t))) {
      result.englishName = tokens.join(' ');
      break;
    }
  }

  let dobMatch = text.match(/(19\d{2}|20[01]\d)[-\s/](\d{1,2})[-\s/](\d{1,2})/);
  if (dobMatch) {
    result.dateOfBirth = `${dobMatch[1]}-${dobMatch[2].padStart(2, '0')}-${dobMatch[3].padStart(2, '0')}`;
  } else {
    const monthMap = {
      JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
      JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
    };
    dobMatch = text.match(/\b(\d{1,2})[\s-]+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[\s-]+(19\d{2}|20[01]\d)\b/i);
    if (dobMatch) {
      const mm = monthMap[dobMatch[2].toUpperCase()];
      result.dateOfBirth = `${dobMatch[3]}-${mm}-${dobMatch[1].padStart(2, '0')}`;
    }
  }

  return result;
}

// ============================== 测试用例 ==============================

const cases = [
  {
    name: 'ICAO 9303 标准样例 (Anna Maria Eriksson)',
    text:
      'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\n' +
      'L898902C36UTO7408122F1204159ZE184226B<<<<<10',
    expectMrz: {
      surname: 'ERIKSSON',
      givenNames: 'ANNA MARIA',
      passportNumber: 'L898902C3', // 前 9 位
      nationality: 'UTO',
      dateOfBirth: '1974-08-12',
      sex: 'F',
    },
  },
  {
    name: '中国护照样例 (E12345678)',
    text:
      'P<CHNZHANG<<SAN<<<<<<<<<<<<<<<<<<<<<<<<<<<<\n' +
      'E123456786CHN9001015M3001015<<<<<<<<<<<<<<02',
    expectMrz: {
      passportNumber: 'E12345678',
      nationality: 'CHN',
      dateOfBirth: '1990-01-01',
      sex: 'M',
    },
  },
  {
    name: 'OCR 噪音：< 被识成 «',
    text:
      'P«CHNZHANG««SAN««««««««««««««««««««««««««««\n' +
      'E123456786CHN9001015M3001015««««««««««««««02',
    expectMrz: {
      passportNumber: 'E12345678',
      nationality: 'CHN',
    },
  },
  {
    name: 'OCR 噪音：P 识错（仅 < 填充符识别正确）',
    text:
      'B<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\n' +
      'L898902C36UTO7408122F1204159ZE184226B<<<<<10',
    expectMrz: {
      passportNumber: 'L898902C3',
    },
  },
  {
    name: 'Fallback 正则：纯文字 OCR（无 MRZ）',
    text:
      'PASSPORT 中华人民共和国\n' +
      'Name/姓名: ZHANG, SAN\n' +
      'Passport No./护照号: E12345678\n' +
      'Date of birth/出生日期: 1990-01-01\n',
    expectFallback: {
      passportNumber: 'E12345678',
      englishName: 'ZHANG SAN',
      dateOfBirth: '1990-01-01',
    },
  },
  {
    name: 'Fallback 正则：国际护照 (US-style 9-digit)',
    text:
      'UNITED STATES OF AMERICA\n' +
      'Surname: SMITH\n' +
      'Given names: JOHN MICHAEL\n' +
      'Passport No.: 123456789\n' +
      'Date of birth: 15 JAN 1990\n',
    expectFallback: {
      passportNumber: '123456789',
      // 期望 "JOHN MICHAEL"：给定名出现在前 + 也是合法的姓名候选
      // 实际产品里我们把 englishName 当作"建议姓名"给用户确认，而非权威字段
      englishName: 'JOHN MICHAEL',
      dateOfBirth: '1990-01-15',
    },
  },
  {
    name: 'Fallback 正则：英国式 (1 letter + 9 digits)',
    text:
      'UNITED KINGDOM\n' +
      'Passport No.: GBR987654321\n', // 这种被前缀字母吃掉，应该匹配纯数字 fallback
    expectFallback: {
      passportNumber: '987654321',
    },
  },
  {
    name: '低质量 OCR：MRZ 行被噪点污染',
    text:
      '随机文字 干扰\n' +
      '  P<CHNZHANG<<SAN<<<<<<<<<<<<<<<<<<<<<<<<<<<<\n' +
      '  E123456786CHN9001015M3001015<<<<<<<<<<<<<<02\n' +
      '更多文字',
    expectMrz: {
      passportNumber: 'E12345678',
    },
  },
];

let pass = 0, fail = 0;

for (const c of cases) {
  console.log(`\n━━━ ${c.name} ━━━`);
  if (c.expectMrz) {
    const got = parseMRZ(c.text);
    if (!got) {
      console.log('  ❌ parseMRZ 返回 undefined');
      fail++;
      continue;
    }
    let allMatch = true;
    for (const [k, v] of Object.entries(c.expectMrz)) {
      const actual = got[k];
      if (actual !== v) {
        console.log(`  ❌ ${k}: 期望 "${v}"  实际 "${actual}"`);
        allMatch = false;
      }
    }
    if (allMatch) {
      console.log('  ✅ MRZ', JSON.stringify(got));
      pass++;
    } else {
      console.log('  完整结果:', JSON.stringify(got));
      fail++;
    }
  } else if (c.expectFallback) {
    const got = extractFallback(c.text);
    let allMatch = true;
    for (const [k, v] of Object.entries(c.expectFallback)) {
      const actual = got[k];
      if (actual !== v) {
        console.log(`  ❌ ${k}: 期望 "${v}"  实际 "${actual}"`);
        allMatch = false;
      }
    }
    if (allMatch) {
      console.log('  ✅ Fallback', JSON.stringify(got));
      pass++;
    } else {
      console.log('  完整结果:', JSON.stringify(got));
      fail++;
    }
  }
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`总计: ${pass} 通过 / ${fail} 失败  (${cases.length} 个用例)`);
process.exit(fail > 0 ? 1 : 0);
