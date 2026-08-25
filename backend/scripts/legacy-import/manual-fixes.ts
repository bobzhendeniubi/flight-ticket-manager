import { readFile } from 'node:fs/promises';
import { cleanDate, normalizeDocumentNumber } from './cleaners.js';

export type ManualDateField = 'birth' | 'date_of_issue' | 'expiry_date';

export interface ManualFixes {
  dateFixesByDocument: Map<string, Partial<Record<ManualDateField, string>>>;
  nameFlagsByPassenger: Map<string, Set<string>>;
}

export function emptyManualFixes(): ManualFixes {
  return {
    dateFixesByDocument: new Map(),
    nameFlagsByPassenger: new Map(),
  };
}

export function passengerNameKey(chinese: unknown, pinyin: unknown): string {
  return `${String(chinese ?? '').trim()}\u0000${String(pinyin ?? '').trim()}`;
}

function splitTsv(text: string, optionName: string, expectedHeader: readonly string[]): string[][] {
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  const firstNonEmpty = lines.findIndex((line) => line.trim() !== '');
  if (firstNonEmpty < 0) throw new Error(`${optionName} 文件为空，缺少表头：${expectedHeader.join('\t')}`);
  const header = lines[firstNonEmpty]!.split('\t');
  if (header.length !== expectedHeader.length || header.some((value, index) => value !== expectedHeader[index])) {
    throw new Error(`${optionName} 文件表头错误，应为：${expectedHeader.join('\t')}`);
  }
  return lines
    .slice(firstNonEmpty + 1)
    .map((line, index) => ({ line, lineNumber: firstNonEmpty + index + 2 }))
    .filter(({ line }) => line.trim() !== '')
    .map(({ line, lineNumber }) => {
      const values = line.split('\t');
      if (values.length !== expectedHeader.length) {
        throw new Error(`${optionName} 文件第 ${lineNumber} 行列数错误，应为 ${expectedHeader.length} 列`);
      }
      return values;
    });
}

async function readTsv(path: string, optionName: string, expectedHeader: readonly string[]): Promise<string[][]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${optionName} 文件读取失败：${detail}`);
  }
  return splitTsv(text, optionName, expectedHeader);
}

export async function loadManualFixes(
  dateFixesPath?: string,
  nameFlagsPath?: string,
): Promise<ManualFixes> {
  const fixes = emptyManualFixes();
  if (dateFixesPath) {
    const rows = await readTsv(dateFixesPath, '--date-fixes', ['documentNumber', 'field', 'correctedValue']);
    rows.forEach((row, index) => {
      const lineNumber = index + 2;
      const documentNumber = normalizeDocumentNumber(row[0]);
      const field = row[1]!.trim() as ManualDateField;
      const correctedValue = row[2]!.trim();
      if (!documentNumber || !['birth', 'date_of_issue', 'expiry_date'].includes(field)) {
        throw new Error(`--date-fixes 文件第 ${lineNumber} 行 field 或 documentNumber 无效`);
      }
      if (!/^\d{2}-\d{2}-\d{4}$/u.test(correctedValue) || cleanDate(correctedValue).value === null) {
        throw new Error(`--date-fixes 文件第 ${lineNumber} 行 correctedValue 必须是有效 DD-MM-YYYY 日期`);
      }
      const byField = fixes.dateFixesByDocument.get(documentNumber) ?? {};
      if (byField[field] !== undefined) {
        throw new Error(`--date-fixes 文件第 ${lineNumber} 行重复指定同一护照号和字段`);
      }
      byField[field] = correctedValue;
      fixes.dateFixesByDocument.set(documentNumber, byField);
    });
  }

  if (nameFlagsPath) {
    const rows = await readTsv(nameFlagsPath, '--name-flags', ['line_no', 'chinese', 'pinyin', 'problem_type', 'confidence', 'note']);
    rows.forEach((row, index) => {
      const lineNumber = index + 2;
      const sourceLine = row[0]!.trim();
      const chinese = row[1]!.trim();
      const pinyin = row[2]!.trim();
      const problemType = row[3]!.trim();
      const confidence = row[4]!.trim();
      if (!/^\d+$/u.test(sourceLine) || !chinese || !pinyin || !problemType || !confidence) {
        throw new Error(`--name-flags 文件第 ${lineNumber} 行 line_no/chinese/pinyin/problem_type/confidence 无效`);
      }
      const key = passengerNameKey(chinese, pinyin);
      const flags = fixes.nameFlagsByPassenger.get(key) ?? new Set<string>();
      flags.add(problemType);
      fixes.nameFlagsByPassenger.set(key, flags);
    });
  }
  return fixes;
}
