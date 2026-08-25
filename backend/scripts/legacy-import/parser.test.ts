import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDump, parseInsertStatement } from './parser.js';

describe('legacy SQL parser', () => {
  it('parses quoted escapes, commas, NULL, and Chinese text', () => {
    const result = parseInsertStatement(
      "INSERT INTO `rs_receipt` VALUES ('r-1','t-1',1,'12.50','2026-08-24T09:10:00','7','O\\'Brien,中文','2026-08-24 09:11:00',NULL,'2026-08-24 09:12:00'),('r-2',NULL,NULL,NULL,NULL,2,'O''Brien',NULL,NULL,NULL);",
    );
    expect(result.issues).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual([
      'r-1', 't-1', '1', '12.50', '2026-08-24T09:10:00', '7', "O'Brien,中文",
      '2026-08-24 09:11:00', null, '2026-08-24 09:12:00',
    ]);
    expect(result.rows[1]?.[6]).toBe("O'Brien");

    const text = parseInsertStatement(
      "INSERT INTO `rs_ticket_flight` VALUES ('link-1','ticket-1','flight-1',0);",
    );
    expect(text.rows[0]).toEqual(['link-1', 'ticket-1', 'flight-1', '0']);
  });

  it('reports a row whose column count does not match the source contract', () => {
    const result = parseInsertStatement("INSERT INTO `rs_ticket_flight` VALUES ('only-one');");
    expect(result.rows).toHaveLength(0);
    expect(result.issues[0]?.reason).toBe('column-count:1/4');
  });

  it('drops an oversized statement and emits a parser issue', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'legacy-parser-'));
    const filePath = join(directory, 'fixture.sql');
    await writeFile(filePath, `INSERT INTO \`rs_ticket_flight\` VALUES ('${'x'.repeat(100)}','t','f',0);\n`);
    try {
      const events = [];
      for await (const event of parseDump(filePath, { maxStatementBytes: 64 })) events.push(event);
      expect(events).toEqual([{
        kind: 'issue',
        issue: { table: 'rs_ticket_flight', lineNumber: 1, reason: 'statement-too-large:64' },
      }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
