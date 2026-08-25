import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export const LEGACY_TABLE_COLUMNS = {
  rs_flight: [
    'id', 'org_id', 'total_sw_count', 'total_jj_count', 'sw_count', 'jj_count', 'flight_no',
    'start_day', 'start_time', 'end_time', 'start_city', 'end_city', 'create_time', 'create_user',
    'update_time', 'update_user', 'adult_sw_price', 'adult_jj_price', 'child_sw_price',
    'child_jj_price', 'infant_sw_price', 'infant_jj_price', 'cost', 'tax_price', 'is_product',
    'flight_hour', 'flight_minute',
  ],
  rs_ticket: [
    'id', 'team_no', 'booking_no', 'product_id', 'type', 'state', 'level', 'true_price',
    'receipt_time', 'receipt_type', 'price', 'final_price', 'deposit_price', 'deposit_true_price',
    'chn_name', 'name', 'passenger_type', 'infant_adult', 'name_document', 'title', 'sex', 'birth',
    'citizenship', 'document_type', 'document_number', 'date_of_issue', 'expiry_date', 'org_id',
    'user_id', 'create_time', 'create_user', 'update_time', 'update_user', 'remark', 'file_id',
    'status', 'ticket_state', 'visa_type', 'visa_state', 'customs_state', 'customs_flight',
    'customs_back_flight', 'hotel_type', 'hotel_type_name', 'is_lock_true_price', 'is_lock',
    'is_lock_deposit', 'is_lock_deposit_true_price', 'refund_channel', 'refund_time', 'refund_price',
    'issue_at', 'birth_place', 'is_same_order', 'deduction_price', 'two_true_price',
    'two_receipt_time', 'two_receipt_type', 'sys_state', 'back_ticket_state', 'hotel_price',
    'hotel_true_price', 'visa_price', 'visa_true_price', 'discount_price', 'final_price_remark',
    'payment_id', 'final_price_type', 'true_price_type',
  ],
  rs_ticket_flight: ['id', 'ticket_id', 'flight_id', 'type'],
  rs_receipt: [
    'id', 'ticket_id', 'sequence', 'price', 'time', 'channel', 'create_user', 'create_time',
    'update_user', 'update_time',
  ],
  sys_emp: ['id', 'job_num', 'org_id', 'org_name'],
} as const;

export type LegacySourceTable = keyof typeof LEGACY_TABLE_COLUMNS;
export type RawSqlValue = string | null;

export interface ParsedSourceRow {
  table: LegacySourceTable;
  values: RawSqlValue[];
  lineNumber: number;
}

export interface ParseIssue {
  table: string;
  lineNumber: number;
  reason: string;
  values?: RawSqlValue[];
}

export type DumpEvent =
  | { kind: 'row'; row: ParsedSourceRow }
  | { kind: 'issue'; issue: ParseIssue };

const INSERT_START = /^\s*INSERT\s+INTO\s+`([^`]+)`\s+VALUES\s*/iu;
export const MAX_STATEMENT_BYTES = 64 * 1024 * 1024;

function isSupportedTable(value: string): value is LegacySourceTable {
  return Object.prototype.hasOwnProperty.call(LEGACY_TABLE_COLUMNS, value);
}

function decodeBackslashEscape(value: string): string {
  switch (value) {
    case '0': return '\0';
    case 'b': return '\b';
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case 'Z': return '\u001a';
    default: return value;
  }
}

function skipWhitespace(input: string, index: number): number {
  let next = index;
  while (next < input.length && /\s/u.test(input[next]!)) next += 1;
  return next;
}

function readQuotedString(input: string, start: number): { value: string; next: number } {
  let index = start + 1;
  let value = '';
  while (index < input.length) {
    const char = input[index]!;
    if (char === '\\') {
      if (index + 1 >= input.length) throw new Error('unterminated backslash escape');
      value += decodeBackslashEscape(input[index + 1]!);
      index += 2;
      continue;
    }
    if (char === "'") {
      if (input[index + 1] === "'") {
        value += "'";
        index += 2;
        continue;
      }
      return { value, next: index + 1 };
    }
    value += char;
    index += 1;
  }
  throw new Error('unterminated quoted string');
}

function readUnquotedValue(input: string, start: number): { value: string | null; next: number } {
  let index = start;
  while (index < input.length && input[index] !== ',' && input[index] !== ')') index += 1;
  const token = input.slice(start, index).trim();
  if (/^NULL$/iu.test(token)) return { value: null, next: index };
  return { value: token, next: index };
}

/**
 * Parse the VALUES portion of one MySQL INSERT statement.
 * The parser deliberately returns raw strings; field-specific coercion belongs in cleaners.ts.
 */
export function parseInsertStatement(statement: string): {
  table: LegacySourceTable | null;
  rows: RawSqlValue[][];
  issues: ParseIssue[];
} {
  const match = INSERT_START.exec(statement);
  if (!match || !isSupportedTable(match[1]!)) {
    return { table: null, rows: [], issues: [] };
  }
  const table = match[1] as LegacySourceTable;
  const expectedColumns = LEGACY_TABLE_COLUMNS[table].length;
  const rows: RawSqlValue[][] = [];
  const issues: ParseIssue[] = [];
  const valuesStart = match[0].length;
  let index = valuesStart;

  try {
    while (index < statement.length) {
      index = skipWhitespace(statement, index);
      while (statement[index] === ',') index = skipWhitespace(statement, index + 1);
      if (index >= statement.length || statement[index] === ';') break;
      if (statement[index] !== '(') throw new Error(`expected tuple at offset ${index}`);
      index += 1;
      const values: RawSqlValue[] = [];
      let tupleClosed = false;
      while (index < statement.length) {
        index = skipWhitespace(statement, index);
        const char = statement[index];
        if (char === "'") {
          const parsed = readQuotedString(statement, index);
          values.push(parsed.value);
          index = parsed.next;
        } else if (char === undefined) {
          throw new Error('unterminated tuple');
        } else {
          const parsed = readUnquotedValue(statement, index);
          values.push(parsed.value);
          index = parsed.next;
        }
        index = skipWhitespace(statement, index);
        if (statement[index] === ',') {
          index += 1;
          continue;
        }
        if (statement[index] === ')') {
          index += 1;
          tupleClosed = true;
          break;
        }
        throw new Error(`expected comma or tuple close at offset ${index}`);
      }
      if (!tupleClosed) throw new Error('unterminated tuple');
      if (values.length !== expectedColumns) {
        issues.push({
          table,
          lineNumber: 0,
          reason: `column-count:${values.length}/${expectedColumns}`,
          values,
        });
      } else {
        rows.push(values);
      }
    }
  } catch (error) {
    issues.push({
      table,
      lineNumber: 0,
      reason: error instanceof Error ? error.message : 'parse-error',
    });
  }
  return { table, rows, issues };
}

function statementHasEnded(input: string): boolean {
  let quoted = false;
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === '\\') {
      escaped = true;
      continue;
    }
    if (char === "'") quoted = !quoted;
    if (!quoted && char === ';') return true;
  }
  return false;
}

/** Stream supported INSERT rows without loading the dump into memory. */
export async function* parseDump(
  filePath: string,
  options: { maxStatementBytes?: number } = {},
): AsyncGenerator<DumpEvent> {
  const maxStatementBytes = options.maxStatementBytes ?? MAX_STATEMENT_BYTES;
  const lines = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });
  let statement = '';
  let statementBytes = 0;
  let statementStartLine = 0;
  let tableCandidate: string | null = null;

  const emitStatement = async function* (): AsyncGenerator<DumpEvent> {
    if (!statement || !tableCandidate || !isSupportedTable(tableCandidate)) return;
    const parsed = parseInsertStatement(statement);
    for (const issue of parsed.issues) {
      yield {
        kind: 'issue',
        issue: { ...issue, lineNumber: statementStartLine },
      };
    }
    if (!parsed.table) return;
    for (const values of parsed.rows) {
      yield {
        kind: 'row',
        row: { table: parsed.table, values, lineNumber: statementStartLine },
      };
    }
  };

  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!statement) {
      const match = INSERT_START.exec(line);
      if (!match) continue;
      const statementStart = line.search(/\bINSERT\s+INTO\s+/iu);
      statement = line.slice(statementStart >= 0 ? statementStart : 0);
      statementBytes = Buffer.byteLength(statement, 'utf8');
      statementStartLine = lineNumber;
      tableCandidate = match[1] ?? null;
    } else {
      statement += `\n${line}`;
      statementBytes += Buffer.byteLength(line, 'utf8') + 1;
    }
    if (statementBytes > maxStatementBytes) {
      yield {
        kind: 'issue',
        issue: {
          table: tableCandidate ?? 'unknown',
          lineNumber: statementStartLine,
          reason: `statement-too-large:${maxStatementBytes}`,
        },
      };
      statement = '';
      statementBytes = 0;
      statementStartLine = 0;
      tableCandidate = null;
      continue;
    }
    if (statementHasEnded(statement)) {
      for await (const event of emitStatement()) yield event;
      statement = '';
      statementBytes = 0;
      statementStartLine = 0;
      tableCandidate = null;
    }
  }
  if (statement) {
    for await (const event of emitStatement()) yield event;
  }
}
