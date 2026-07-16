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

// 存量脏数据已洗过一轮，但录单入口此前只规范化 fullName，lastName/firstName 是裸 z.string()：
// 前端 blur 只挡人手录单，非 UI 路径（代理 API / 批量导入 / 前台）仍能把脏格式直接写进库。
describe('passengerInputSchema · lastName/firstName 规范化（非 UI 路径兜底）', () => {
  it('非 UI 路径传 `ZHENG,` → 入库已规范化为 ZHENG', () => {
    const parsed = passengerInputSchema.parse({
      ...BASE_PASSENGER,
      fullName: 'ZHENG/QINQIN',
      lastName: 'ZHENG,',
      firstName: 'qinqin',
    });
    expect(parsed.lastName).toBe('ZHENG');
    expect(parsed.firstName).toBe('QINQIN');
  });

  it('大小写/句点/多余空白一并规范化', () => {
    const parsed = passengerInputSchema.parse({
      ...BASE_PASSENGER,
      fullName: 'ZHANG/SAN',
      lastName: '  zhang. ',
      firstName: 'san  jr.',
    });
    expect(parsed.lastName).toBe('ZHANG');
    expect(parsed.firstName).toBe('SAN JR');
  });

  it('空格分隔的复姓不被改成斜线（VAN DER BERG 保持原样）', () => {
    const parsed = passengerInputSchema.parse({
      ...BASE_PASSENGER,
      fullName: 'VAN DER BERG/PIET',
      lastName: 'van der berg',
    });
    expect(parsed.lastName).toBe('VAN DER BERG');
  });

  it('未传姓/名保持 undefined（不误变成空字符串）', () => {
    const parsed = passengerInputSchema.parse({
      ...BASE_PASSENGER,
      fullName: 'ZHANG/SAN',
    });
    expect(parsed.lastName).toBeUndefined();
    expect(parsed.firstName).toBeUndefined();
  });
});

// '/' 在单段字段里只可能是「整名塞进了姓栏」——放过去会让导出层拼出 `ZHENG/QIN/MEI`
// 三段名，航司系统拒收，且要到出票才暴露。故在入口硬拒。
describe('passengerInputSchema · 单段姓/名不得含斜线', () => {
  it('整名塞进 lastName（ZHENG/QIN）被拒', () => {
    expect(() =>
      passengerInputSchema.parse({
        ...BASE_PASSENGER,
        fullName: 'ZHENG/QIN',
        lastName: 'ZHENG/QIN',
        firstName: 'MEI',
      }),
    ).toThrow();
  });

  it('逗号规范化后变成内嵌斜线（ZHENG,QIN）同样被拒', () => {
    expect(() =>
      passengerInputSchema.parse({
        ...BASE_PASSENGER,
        fullName: 'ZHENG/QIN',
        lastName: 'ZHENG,QIN',
      }),
    ).toThrow();
  });

  it('firstName 含斜线同样被拒', () => {
    expect(() =>
      passengerInputSchema.parse({
        ...BASE_PASSENGER,
        fullName: 'ZHENG/QIN',
        firstName: 'QIN/MEI',
      }),
    ).toThrow();
  });

  it('尾随斜线只是脏格式、规范化后即为单段 → 放行（不误伤）', () => {
    const parsed = passengerInputSchema.parse({
      ...BASE_PASSENGER,
      fullName: 'ZHENG/QINQIN',
      lastName: 'ZHENG/',
    });
    expect(parsed.lastName).toBe('ZHENG');
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

  // 换人与录单同款：单段姓/名里的 '/' 只可能是整名塞错栏，放过去会让导出层拼出三段名。
  it('整名塞进 lastName（ZHENG/QIN）被拒', () => {
    expect(() =>
      swapPassengerBodySchema.parse({ lastName: 'ZHENG/QIN', firstName: 'MEI' }),
    ).toThrow();
  });

  it('firstName 含斜线同样被拒', () => {
    expect(() => swapPassengerBodySchema.parse({ firstName: 'QIN/MEI' })).toThrow();
  });

  it('fullName 里的斜线仍合法（整名分隔符，不受单段校验影响）', () => {
    const parsed = swapPassengerBodySchema.parse({ fullName: 'ZHENG/QINQIN' });
    expect(parsed.fullName).toBe('ZHENG/QINQIN');
  });
});
