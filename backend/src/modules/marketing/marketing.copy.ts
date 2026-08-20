/**
 * 配套文案生成 —— 模型只写带占位符的文案模板，硬数据由服务端替换。
 *
 * 这样模型即使自行编造航班号、时刻或日期，也不会进入最终文案：该段会被丢弃，
 * 只针对该段重试一次，并把原因记录到海报的渲染元信息中。
 */
import type { QwenConfig } from '../../lib/qwen-config.js';
import type { FlightRouteSummary, PosterFact } from './marketing.facts.js';

export const COPY_MODEL = 'qwen3-max';

const COPY_TIMEOUT_MS = 60_000;

export type PosterCopyKind = 'moments' | 'agent' | 'xhs';

export interface PosterCopy {
  moments: string | null;
  agent: string | null;
  xhs: string | null;
}

export interface PosterCopyRejection {
  kind: PosterCopyKind;
  reason: string;
}

export interface PosterCopyResult {
  copy: PosterCopy;
  rejected: PosterCopyRejection[];
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

const PLACEHOLDER_NAMES = new Set([
  'outboundFlight',
  'outboundTime',
  'outboundRoute',
  'route',
  'inboundFlight',
  'inboundTime',
  'inboundRoute',
  'effectiveFrom',
  'baggage',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function factValue(facts: PosterFact[], key: string): string | null {
  const fact = facts.find((item) => item.key === key);
  return fact?.value.trim() || null;
}

function placeholderValues(facts: PosterFact[]): Map<string, string | null> {
  const outboundRoute = factValue(facts, 'outbound.route');
  return new Map([
    ['outboundFlight', factValue(facts, 'outbound.flightNumber')],
    ['outboundTime', factValue(facts, 'outbound.time')],
    ['outboundRoute', outboundRoute],
    ['route', outboundRoute],
    ['inboundFlight', factValue(facts, 'inbound.flightNumber')],
    ['inboundTime', factValue(facts, 'inbound.time')],
    ['inboundRoute', factValue(facts, 'inbound.route')],
    ['effectiveFrom', factValue(facts, 'effectiveFrom')],
    ['baggage', factValue(facts, 'baggage')],
  ]);
}

function placeholderNames(text: string): string[] {
  const names: string[] = [];
  const pattern = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) names.push(match[1]);
  return names;
}

function normalizeHardText(text: string): string {
  return text
    .replace(/[０-９]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - '０'.charCodeAt(0) + 48))
    .replace(/[Ａ-Ｚａ-ｚ]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - (char <= 'Ｚ' ? 'Ａ'.charCodeAt(0) : 'ａ'.charCodeAt(0)) + (char <= 'Ｚ' ? 65 : 97)))
    .replace(/：/gu, ':')
    .toUpperCase();
}

function normalizeFlight(value: string): string {
  return normalizeHardText(value).replace(/\s+/gu, '');
}

function dateKey(value: string): string {
  const normalized = normalizeHardText(value);
  const full = /(\d{4})\s*(?:年|[./-])\s*(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})\s*日?/u.exec(normalized);
  if (full) return `${full[1]}-${Number(full[2])}-${Number(full[3])}`;
  const short = /(\d{1,2})\s*月\s*(\d{1,2})\s*日?/u.exec(normalized);
  return short ? `${Number(short[1])}-${Number(short[2])}` : normalized;
}

function canonicalTime(hour: string, minute: string): string {
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

/** 从文案中抽取所有可能的航班号，支持数字开头航司码及全角字符。 */
export function extractFlightCandidates(text: string): string[] {
  const normalized = normalizeHardText(text);
  const values: string[] = [];
  const pattern = /(?<![A-Z0-9])(?:[A-Z]{1,3}\s*\d{2,6}|\d[A-Z]\s*\d{2,6})(?![A-Z0-9])/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    const value = normalizeFlight(match[0]);
    if (value.length >= 3 && value.length <= 8) values.push(value);
  }
  return values;
}

/** 从文案中抽取冒号、中文「点/時」写法的时刻。 */
export function extractTimeCandidates(text: string): string[] {
  const normalized = normalizeHardText(text);
  const values: string[] = [];
  const pattern = /(?<!\d)(\d{1,2})(?::(\d{1,2})|[点時](\d{1,2})分?)(?!\d)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    const minute = match[2] ?? match[3];
    const hour = Number(match[1]);
    const minutes = Number(minute);
    values.push(hour <= 23 && minutes <= 59 ? canonicalTime(match[1], minute) : match[0]);
  }
  return values;
}

/** 从文案中抽取年月日及月日写法。 */
export function extractDateCandidates(text: string): string[] {
  const normalized = normalizeHardText(text);
  const values: string[] = [];
  const full = /\d{4}\s*(?:年|[./-])\s*\d{1,2}\s*(?:月|[./-])\s*\d{1,2}\s*日?/gu;
  const short = /\d{1,2}\s*月\s*\d{1,2}\s*日?/gu;
  for (const match of normalized.matchAll(full)) values.push(dateKey(match[0]));
  for (const match of normalized.matchAll(short)) values.push(dateKey(match[0]));
  return values;
}

function allowedHardData(facts: PosterFact[]): { flights: Set<string>; times: Set<string>; dates: Set<string> } {
  const flights = new Set(
    facts.filter((fact) => /\.flightNumber$/u.test(fact.key)).map((fact) => normalizeFlight(fact.value)),
  );
  const times = new Set(
    facts.filter((fact) => /\.time$/u.test(fact.key)).flatMap((fact) => extractTimeCandidates(fact.value)),
  );
  const dates = new Set(
    facts.filter((fact) => fact.key === 'effectiveFrom').flatMap((fact) => extractDateCandidates(fact.value)),
  );
  return { flights, times, dates };
}

/** 白名单校验：只有事实快照中的航班号、时刻和日期可以出现在模板里。 */
export function findUnsupportedHardData(text: string, facts: PosterFact[]): string[] {
  const allowed = allowedHardData(facts);
  const reasons: string[] = [];
  for (const value of extractFlightCandidates(text)) {
    if (!allowed.flights.has(value)) reasons.push(`出现未被事实快照允许的具体航班号：${value}`);
  }
  for (const value of extractTimeCandidates(text)) {
    if (!allowed.times.has(value)) reasons.push(`出现未被事实快照允许的具体时刻：${value}`);
  }
  for (const value of extractDateCandidates(text)) {
    if (!allowed.dates.has(value)) reasons.push(`出现未被事实快照允许的具体日期：${value}`);
  }
  return reasons;
}

function replaceTemplate(text: string, facts: PosterFact[]): { value: string; reason: string | null } {
  const values = placeholderValues(facts);
  const names = placeholderNames(text);
  if (names.length === 0) return { value: '', reason: '模板未包含事实占位符' };

  const unknown = names.find((name) => !PLACEHOLDER_NAMES.has(name));
  if (unknown) return { value: '', reason: `包含未知占位符 {{${unknown}}}` };

  const missing = names.find((name) => values.get(name) === null);
  if (missing) return { value: '', reason: `占位符 {{${missing}}} 没有对应事实值` };

  const value = text.replace(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/gu, (_match, name: string) => {
    return values.get(name) ?? '';
  }).trim();
  if (value.includes('{{') || value.includes('}}')) {
    return { value: '', reason: '替换后仍有未解析占位符' };
  }
  return value ? { value, reason: null } : { value: '', reason: '替换事实后文案为空' };
}

/** 把模型候选转换为最终文案；替换前先拦截模型自行写出的硬数据。 */
export function sanitizePosterCopy(candidate: unknown, facts: PosterFact[]): PosterCopyResult {
  const copy: PosterCopy = { moments: null, agent: null, xhs: null };
  const rejected: PosterCopyRejection[] = [];

  for (const kind of ['moments', 'agent', 'xhs'] as const) {
    const value = isRecord(candidate) && typeof candidate[kind] === 'string'
      ? candidate[kind].trim()
      : '';
    const reasons = value ? findUnsupportedHardData(value, facts) : ['模型未返回该段模板'];
    const replacement = value ? replaceTemplate(value, facts) : { value: '', reason: null };
    if (replacement.reason) reasons.push(replacement.reason);
    if (reasons.length > 0) {
      rejected.push({ kind, reason: reasons.join('；') });
      continue;
    }
    copy[kind] = replacement.value;
  }

  return { copy, rejected };
}

function placeholderPrompt(summary: FlightRouteSummary): string[] {
  const rows = [
    '{{outboundFlight}}：去程航班号',
    '{{outboundTime}}：去程起飞-到达时刻',
    '{{outboundRoute}} 或 {{route}}：去程航线',
  ];
  if (summary.inbound) {
    rows.push(
      '{{inboundFlight}}：回程航班号',
      '{{inboundTime}}：回程起飞-到达时刻',
      '{{inboundRoute}}：回程航线',
    );
  }
  if (summary.effectiveFrom) rows.push('{{effectiveFrom}}：生效日期文案');
  if (summary.baggageText) rows.push('{{baggage}}：行李额');
  return rows;
}

const SYSTEM_PROMPT =
  '你是旅游产品的营销文案编辑，服务的是休闲度假客人。' +
  '写中文，说人话，不要浮夸的排比和空洞形容词。' +
  '严格输出 JSON，不要 markdown 代码块，不要任何解释。' +
  '必须使用给出的占位符表达硬数据，禁止自行写出任何航班号、时刻或日期。';

async function requestPosterCopy(cfg: QwenConfig, userPrompt: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COPY_TIMEOUT_MS);

  try {
    const res = await fetch(`${cfg.compatibleBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: COPY_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    const body = (await res.json()) as ChatResponse;
    if (!res.ok || body.error) return null;
    const raw = body.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function segmentPrompt(summary: FlightRouteSummary, extraNote: string | undefined, kind: PosterCopyKind): string {
  const tone = kind === 'moments'
    ? '朋友圈文案，60-100字，口语化，可带少量 emoji，结尾引导私信咨询'
    : kind === 'agent'
      ? '发代理群的文案，100-150字，时刻和行李额放前面，说清楚怎么订，不用 emoji'
      : '小红书笔记，150-220字，第一人称有体验感，结尾带3-5个#标签';
  return [
    '只重新生成以下一段营销文案模板，严格输出 JSON，不要 markdown 或解释。',
    `口吻要求：${tone}`,
    '必须使用给出的占位符表达硬数据，禁止自行写出任何航班号、时刻或日期数字。',
    '可用占位符：',
    ...placeholderPrompt(summary),
    extraNote?.trim() ? `补充要求：${extraNote.trim()}（其中的硬数据不得直接复制）` : '',
    `输出格式：{"${kind}": "带占位符的文案模板"}`,
  ].filter(Boolean).join('\n');
}

/** 生成三种口吻；只重试被拒绝的段落，保留首轮已经通过的段落。 */
export async function generatePosterCopy(
  cfg: QwenConfig,
  summary: FlightRouteSummary,
  facts: PosterFact[],
  extraNote?: string,
): Promise<PosterCopyResult | null> {
  const userPrompt = [
    '根据以下占位符说明，写三条带占位符的文案模板。不要写出任何具体航班号、时刻、日期数字。',
    '',
    '【可用占位符】',
    ...placeholderPrompt(summary),
    extraNote?.trim() ? `\n【补充要求】\n${extraNote.trim()}\n（补充要求中的硬数据也不得直接复制，必须改用占位符。）` : '',
    '',
    '【输出 JSON】',
    '{',
    '  "moments": "朋友圈文案，60-100字，口语化，可带少量 emoji，必须至少使用一个占位符，结尾引导私信咨询",',
    '  "agent": "发代理群的文案，100-150字，时刻和行李额放前面，必须至少使用一个占位符，说清楚怎么订，不用 emoji",',
    '  "xhs": "小红书笔记，150-220字，第一人称有体验感，必须至少使用一个占位符，结尾带3-5个#标签"',
    '}',
  ].join('\n');

  const first = await requestPosterCopy(cfg, userPrompt);
  if (first === null) return null;

  const firstResult = sanitizePosterCopy(first, facts);
  if (firstResult.rejected.length === 0) return firstResult;

  const merged: PosterCopy = { ...firstResult.copy };
  const rejected: PosterCopyRejection[] = [];
  for (const failed of firstResult.rejected) {
    const retry = await requestPosterCopy(cfg, segmentPrompt(summary, extraNote, failed.kind));
    const retryCandidate = isRecord(retry) ? retry : { [failed.kind]: typeof retry === 'string' ? retry : '' };
    const retryResult = sanitizePosterCopy(retryCandidate, facts);
    const replacement = retryResult.copy[failed.kind];
    const retryFailure = retryResult.rejected.find((item) => item.kind === failed.kind);
    if (replacement !== null && replacement !== undefined) {
      merged[failed.kind] = replacement;
    } else {
      rejected.push({ kind: failed.kind, reason: retryFailure?.reason ?? `重试后仍不可信：${failed.reason}` });
    }
  }
  return { copy: merged, rejected };
}
