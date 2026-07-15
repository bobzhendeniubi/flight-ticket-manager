// 0715 反馈 4：录单/换人姓名 schema 层兜底规范化——
// 脏格式姓名（如 `ZHENG,/QINQIN` 姓里带逗号）不应原样入库污染导出名单。
// 前端 admin-web 已有同规则的 onBlur/OCR 回填规范化，这里补服务端边界兜底（不依赖客户端行为）。
import { describe, expect, it } from 'vitest';
import {
  passengerInputSchema,
  swapPassengerBodySchema,
} from './orders.schemas.js';

const BASE_PASSENGER = {
  documentNumber: 'E12345678',
  dateOfBirth: '1990-01-01',
};

describe('passengerInputSchema · fullName 规范化', () => {
  it('逗号脏格式 → 斜线分隔（ZHENG,/QINQIN → ZHENG/QINQIN）', () => {
    const parsed = passengerInputSchema.parse({
      ...BASE_PASSENGER,
      fullName: 'ZHENG,/QINQIN',
    });
    expect(parsed.fullName).toBe('ZHENG/QINQIN');
  });

  it('已规范的姓名保持不变', () => {
    const parsed = passengerInputSchema.parse({
      ...BASE_PASSENGER,
      fullName: 'ZHANG/SAN',
    });
    expect(parsed.fullName).toBe('ZHANG/SAN');
  });

  it('空字符串仍被 min(1) 拒绝（规范化不绕过必填校验）', () => {
    expect(() =>
      passengerInputSchema.parse({ ...BASE_PASSENGER, fullName: '' }),
    ).toThrow();
  });
});

describe('swapPassengerBodySchema · fullName/lastName/firstName 规范化', () => {
  it('fullName 逗号脏格式 → 斜线分隔', () => {
    const parsed = swapPassengerBodySchema.parse({
      fullName: 'ZHENG,/QINQIN',
    });
    expect(parsed.fullName).toBe('ZHENG/QINQIN');
  });

  it('lastName/firstName 各自单段规范化（不做斜线拼接）', () => {
    const parsed = swapPassengerBodySchema.parse({
      lastName: 'zheng.',
      firstName: 'qin qin',
    });
    expect(parsed.lastName).toBe('ZHENG');
    expect(parsed.firstName).toBe('QIN QIN');
  });

  it('未传字段保持 undefined（不误变成空字符串）', () => {
    const parsed = swapPassengerBodySchema.parse({ documentNumber: 'E99999999' });
    expect(parsed.fullName).toBeUndefined();
    expect(parsed.lastName).toBeUndefined();
    expect(parsed.firstName).toBeUndefined();
  });
});
