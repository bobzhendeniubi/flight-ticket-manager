import { describe, it, expect } from 'vitest';
import {
  normalizePassengerFullName,
  composePassengerFullName,
  splitPassengerFullName,
} from './passenger-name.js';

describe('splitPassengerFullName', () => {
  it('斜线格式：ZHANG/SAN → 姓 ZHANG、名 SAN，且姓里不含斜线', () => {
    const { lastName, firstName } = splitPassengerFullName('ZHANG/SAN');
    expect(lastName).toBe('ZHANG');
    expect(firstName).toBe('SAN');
    expect(lastName).not.toContain('/');
  });

  it('斜线优先于空格：VAN DER/PIET → 姓 VAN DER、名 PIET', () => {
    expect(splitPassengerFullName('VAN DER/PIET')).toEqual({
      lastName: 'VAN DER',
      firstName: 'PIET',
    });
  });

  it('斜线后含多段名：WONG/TAK MING → 姓 WONG、名 TAK MING', () => {
    expect(splitPassengerFullName('WONG/TAK MING')).toEqual({
      lastName: 'WONG',
      firstName: 'TAK MING',
    });
  });

  it('无斜线：按首个空格拆 WANG LIANBO → 姓 WANG、名 LIANBO', () => {
    expect(splitPassengerFullName('WANG LIANBO')).toEqual({
      lastName: 'WANG',
      firstName: 'LIANBO',
    });
  });

  it('斜线两侧留空格：ZHANG / SAN → 照样拆干净', () => {
    expect(splitPassengerFullName('ZHANG / SAN')).toEqual({
      lastName: 'ZHANG',
      firstName: 'SAN',
    });
  });

  it('拆不出就不编造：单段名 MADONNA → 姓 MADONNA、名空', () => {
    expect(splitPassengerFullName('MADONNA')).toEqual({
      lastName: 'MADONNA',
      firstName: '',
    });
  });

  it('首字符即斜线（脏数据 /SAN）→ 不拆，整串进姓，不产生空姓', () => {
    expect(splitPassengerFullName('/SAN')).toEqual({ lastName: '/SAN', firstName: '' });
  });

  it('空 / null / undefined → 两栏皆空串', () => {
    expect(splitPassengerFullName('')).toEqual({ lastName: '', firstName: '' });
    expect(splitPassengerFullName(null)).toEqual({ lastName: '', firstName: '' });
    expect(splitPassengerFullName(undefined)).toEqual({ lastName: '', firstName: '' });
  });
});

describe('normalizePassengerFullName', () => {
  it('姓里带逗号紧贴斜线：ZHENG,/QINQIN → ZHENG/QINQIN', () => {
    expect(normalizePassengerFullName('ZHENG,/QINQIN')).toBe('ZHENG/QINQIN');
  });

  it('逗号+空格视为姓/名分隔：ZHENG, QINQIN → ZHENG/QINQIN', () => {
    expect(normalizePassengerFullName('ZHENG, QINQIN')).toBe('ZHENG/QINQIN');
  });

  it('小写转大写：qu/dapeng → QU/DAPENG', () => {
    expect(normalizePassengerFullName('qu/dapeng')).toBe('QU/DAPENG');
  });

  it('纯空格分隔不自动拆斜线（只大写）：van der berg piet → VAN DER BERG PIET', () => {
    expect(normalizePassengerFullName('van der berg piet')).toBe(
      'VAN DER BERG PIET',
    );
  });

  it('中文名原样保留', () => {
    expect(normalizePassengerFullName('郑沁沁')).toBe('郑沁沁');
  });

  it('去句点、折叠空白、trim', () => {
    expect(normalizePassengerFullName('  JR.  SMITH ')).toBe('JR SMITH');
  });

  it("'/' 两侧空格去除", () => {
    expect(normalizePassengerFullName('ZHENG / QINQIN')).toBe('ZHENG/QINQIN');
  });

  it('非字符串入参返回空串而不抛错', () => {
    // @ts-expect-error 故意传非法类型
    expect(normalizePassengerFullName(null)).toBe('');
  });
});

describe('composePassengerFullName', () => {
  it('姓带逗号也能组合：compose(ZHENG, , QINQIN) → ZHENG/QINQIN', () => {
    expect(composePassengerFullName('ZHENG,', 'QINQIN')).toBe('ZHENG/QINQIN');
  });

  it('姓名齐全组合为 LAST/FIRST', () => {
    expect(composePassengerFullName('QU', 'DAPENG')).toBe('QU/DAPENG');
  });

  it('只有姓 → 返回规范化的姓', () => {
    expect(composePassengerFullName('QU', null)).toBe('QU');
  });

  it('只有名 → 返回规范化的名', () => {
    expect(composePassengerFullName(null, 'dapeng')).toBe('DAPENG');
  });

  it('两者皆空 → null', () => {
    expect(composePassengerFullName(null, undefined)).toBeNull();
    expect(composePassengerFullName('', '')).toBeNull();
  });
});
