export interface DraftHardFacts {
  orderNumber: string | null;
  amount: string | null;
  totalAmount: string | null;
  paidAmount: string | null;
  dueDate: string | null;
  departureDate: string | null;
}

export type DraftFactKey = keyof DraftHardFacts;

const PLACEHOLDER_PATTERN = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;
const ALLOWED_PLACEHOLDERS = new Set<DraftFactKey>([
  'orderNumber',
  'amount',
  'totalAmount',
  'paidAmount',
  'dueDate',
  'departureDate',
]);

/** 检查模板中是否有占位符之外的数字、日期、金额或订单号样式内容。 */
export function findUnauthorizedHardData(template: string): string | null {
  const withoutPlaceholders = template.replace(PLACEHOLDER_PATTERN, '');
  if (/[0-9０-９]/u.test(withoutPlaceholders)) return '包含未授权的数字或日期';
  if (/[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二两三四五六七八九十百千万亿]+)?(?:元|块|人民币)/u.test(withoutPlaceholders)) {
    return '包含未授权的中文金额';
  }
  if (/[零〇一二三四五六七八九十]+月(?:[零〇一二三四五六七八九十]+日)?/u.test(withoutPlaceholders)) {
    return '包含未授权的中文日期';
  }
  if (/\b[A-Z]{2,}(?:[-_][A-Z0-9]+)+\b/u.test(withoutPlaceholders)) {
    return '包含未授权的订单号样式内容';
  }
  return null;
}

export type DraftTemplateResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/** 校验模板占位符并用数据库真值替换，失败时不返回可发送文本。 */
export function renderDraftTemplate(
  template: string,
  facts: DraftHardFacts,
): DraftTemplateResult {
  const placeholders = Array.from(template.matchAll(PLACEHOLDER_PATTERN));
  for (const match of placeholders) {
    const key = match[1] as DraftFactKey;
    if (!ALLOWED_PLACEHOLDERS.has(key)) {
      return { ok: false, reason: `包含未知占位符 {{${match[1]}}}` };
    }
    if (facts[key] === null) {
      return { ok: false, reason: `使用了未提供的占位符 {{${match[1]}}}` };
    }
  }

  const unauthorized = findUnauthorizedHardData(template);
  if (unauthorized) return { ok: false, reason: unauthorized };

  const text = template.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    const value = facts[key as DraftFactKey];
    return value ?? '';
  });
  return { ok: true, text };
}
