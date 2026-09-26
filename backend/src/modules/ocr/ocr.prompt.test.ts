import { describe, it, expect } from 'vitest';
import { PASSPORT_OCR_PROMPT } from './ocr.prompt.js';

// 省级行政区简称：提示词里出现任何一个都可能被模型当示例照抄（旧版示例地名被照抄过上千次）。
const PROVINCE_NAMES = [
  '北京', '天津', '上海', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽',
  '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西',
  '甘肃', '青海', '台湾', '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港', '澳门',
];

// 签发机关的常见字样：同理不能出现在提示词里（签发地点曾被大量填成机关名）。
const AUTHORITY_WORDS = ['管理局', '公安部', '公安厅', '出入境', '移民', '入境事务'];

describe('护照 OCR 提示词 — 不含会被照抄的示例值', () => {
  it('不含任何省级地名', () => {
    const hits = PROVINCE_NAMES.filter((n) => PASSPORT_OCR_PROMPT.includes(n));
    expect(hits).toEqual([]);
  });

  it('不含签发机关名称字样', () => {
    const hits = AUTHORITY_WORDS.filter((w) => PASSPORT_OCR_PROMPT.includes(w));
    expect(hits).toEqual([]);
  });

  it('不含具体日期、证件号样例', () => {
    expect(PASSPORT_OCR_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(PASSPORT_OCR_PROMPT).not.toMatch(/[A-Z]{1,2}\d{7,8}/);
  });
});

describe('护照 OCR 提示词 — 签发地点口径', () => {
  it('按护照上的栏目名区分签发地点与签发机关', () => {
    expect(PASSPORT_OCR_PROMPT).toContain('签发地点/Place of issue');
    expect(PASSPORT_OCR_PROMPT).toContain('签发机关/Authority');
  });

  it('不再把签发地点与签发机关写成同一个字段', () => {
    expect(PASSPORT_OCR_PROMPT).not.toContain('签发地点/签发机关');
  });
});
