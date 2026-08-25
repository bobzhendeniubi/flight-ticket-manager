import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapTicket, type ManualFixCounts } from './import.js';
import { loadManualFixes } from './manual-fixes.js';
import type { RawSqlValue } from './parser.js';

async function withManualFiles<T>(
  dateFixes: string,
  nameFlags: string,
  callback: (datePath: string, namePath: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'legacy-manual-fixes-'));
  const datePath = join(directory, 'date-fixes.tsv');
  const namePath = join(directory, 'name-flags.tsv');
  await writeFile(datePath, dateFixes);
  await writeFile(namePath, nameFlags);
  try {
    return await callback(datePath, namePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function ticketValues(): RawSqlValue[] {
  const values = Array<RawSqlValue>(69).fill(null);
  values[0] = 'ticket-1';
  values[14] = '张示例例';
  values[15] = 'ZHANG SHI LI LI';
  values[21] = '01-01-2000';
  values[24] = ' p-1 ';
  values[25] = '01-01-2020';
  values[26] = '01-01-2030';
  values[29] = '2026-08-24 10:00:00';
  return values;
}

describe('legacy manual review files', () => {
  it('loads date fixes and name flags and applies them to every matching ticket row', async () => {
    await withManualFiles(
      'documentNumber\tfield\tcorrectedValue\n P-1 \tbirth\t02-02-2000\n',
      'line_no\tchinese\tpinyin\tproblem_type\tconfidence\tnote\n42\t张示例例\tZHANG SHI LI LI\tpinyin-typo\t0.9\t人工复核\n',
      async (datePath, namePath) => {
        const fixes = await loadManualFixes(datePath, namePath);
        const counts: ManualFixCounts = { manualDateFixes: 0, nameFlags: 0 };
        const issues: Record<string, number> = {};
        const row = mapTicket(
          ticketValues(),
          new Map([['flight-1', { id: 'flight-1', flightNo: 'QH1', departDate: new Date('2026-08-24T00:00:00.000Z') }]]),
          new Map([['ticket-1', [{ id: 'link-1', ticketId: 'ticket-1', flightId: 'flight-1', legType: 0 }]]]),
          new Map(),
          issues,
          fixes,
          counts,
        );
        expect(row.birthDate?.toISOString()).toBe('2000-02-02T00:00:00.000Z');
        expect(row.dataIssues).toEqual(expect.arrayContaining(['birth:manual-fix', 'name:pinyin-typo']));
        expect(counts).toEqual({ manualDateFixes: 1, nameFlags: 1 });
      },
    );
  });

  it('rejects malformed manual-file headers with a clear option-specific error', async () => {
    await expect(withManualFiles(
      'documentNumber\tfield\nP-1\tbirth\n',
      'line_no\tchinese\tpinyin\tproblem_type\tconfidence\tnote\n',
      async (datePath, namePath) => loadManualFixes(datePath, namePath),
    )).rejects.toThrow('--date-fixes 文件表头错误');
  });

  it('normalizes manual-fix passport keys before duplicate detection', async () => {
    await expect(withManualFiles(
      'documentNumber\tfield\tcorrectedValue\n p-1 \tbirth\t02-02-2000\nP-1\tbirth\t03-03-2000\n',
      'line_no\tchinese\tpinyin\tproblem_type\tconfidence\tnote\n',
      async (datePath, namePath) => loadManualFixes(datePath, namePath),
    )).rejects.toThrow('--date-fixes 文件第 3 行重复指定同一护照号和字段');
  });

  it('adds cross-field passport and birth quality flags without changing values', () => {
    const values = ticketValues();
    values[21] = '02-01-2027';
    values[25] = '02-01-2027';
    values[26] = '01-01-2026';
    const row = mapTicket(
      values,
      new Map([['flight-1', { id: 'flight-1', flightNo: 'QH1', departDate: new Date('2026-08-24T00:00:00.000Z') }]]),
      new Map([['ticket-1', [{ id: 'link-1', ticketId: 'ticket-1', flightId: 'flight-1', legType: 0 }]]]),
      new Map(),
      {},
    );
    expect(row.dataIssues).toEqual(expect.arrayContaining([
      'passport:expiry-before-issue',
      'passport:issued-after-order',
      'birth:after-order',
      'birth:year-out-of-range',
      'passport:expired-at-departure',
    ]));
  });
});
