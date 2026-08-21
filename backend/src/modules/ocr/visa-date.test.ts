import { describe, expect, it } from 'vitest';
import { normalizeVisaDate } from './visa-date.js';

describe('normalizeVisaDate', () => {
  it.each([
    ['15/08/2026', '2026-08-15'],
    ['15-08-2026', '2026-08-15'],
    ['2026-08-15', '2026-08-15'],
    ['15 AUG 2026', '2026-08-15'],
    ['15 Aug 2026', '2026-08-15'],
    ['2026/8/5', '2026-08-05'],
    ['05/06/2026', '2026-06-05'],
    ['15/08/26', '2026-08-15'],
    ['１５／０８／２０２６', '2026-08-15'],
    ['  15 / 08 / 2026  ', '2026-08-15'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeVisaDate(raw)).toBe(expected);
  });

  it.each(['31/02/2026', '', '签证日期看不清'])('%s → null', (raw) => {
    expect(normalizeVisaDate(raw)).toBeNull();
  });
});
