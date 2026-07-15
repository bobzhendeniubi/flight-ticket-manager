import { describe, it, expect } from 'vitest';
import {
  normalizePassengerFullName,
  composePassengerFullName,
} from './passenger-name.js';

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
