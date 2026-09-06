/**
 * 供应商应付页签的纯展示函数 —— 不 fetch、不依赖 React，可单测。
 *
 * 刻意只做「把后端给的数字翻译成人眼能扫的东西」，**不重算任何口径**：
 * 核销进度用后端已经算好的 paidAmount / amount（原币，与后端 deriveInvoiceStatus 同一侧），
 * 差额级别直接用后端 diff.level（阈值只有后端一份，前端再写一遍必然漂移）。
 */
import type { ReconcileDiffLevel, SupplierInvoiceStatus } from './payablesApi';

/**
 * 核销进度（0~1）。按**原币**比，与后端判「付清没有」同一侧——
 * 拿 CNY 折算侧算进度，会因为分次付款汇率不同而出现「付满了但进度条不满」。
 *
 * 账单金额 ≤0（脏数据）时返回 0 而不是 NaN/Infinity：进度条不该因为一条烂数据整行崩掉。
 * 付超了（后端拒，但历史数据可能有）夹到 1，不画出格子外面。
 */
export function payProgress(paidAmount: number, amount: number): number {
  if (!Number.isFinite(paidAmount) || !Number.isFinite(amount)) return 0;
  if (amount <= 0) return 0;
  const pct = paidAmount / amount;
  if (pct <= 0) return 0;
  return pct >= 1 ? 1 : pct;
}

/** 进度条颜色：付清=绿，动过钱=琥珀，一分没付=灰。 */
export function payProgressTone(paidAmount: number, amount: number): 'done' | 'partial' | 'none' {
  const pct = payProgress(paidAmount, amount);
  if (pct >= 1) return 'done';
  return pct > 0 ? 'partial' : 'none';
}

const PROGRESS_BAR_CLASS: Record<'done' | 'partial' | 'none', string> = {
  done: 'bg-emerald-500',
  partial: 'bg-amber-500',
  none: 'bg-slate-300',
};

export function payProgressBarClass(paidAmount: number, amount: number): string {
  return PROGRESS_BAR_CLASS[payProgressTone(paidAmount, amount)];
}

/** 「1,200.00 / 3,000.00 USD（40%）」——进度条底下那行字。 */
export function payProgressLabel(paidAmount: number, amount: number, currency: string): string {
  const pct = Math.round(payProgress(paidAmount, amount) * 100);
  return `${fmtAmount(paidAmount)} / ${fmtAmount(amount)} ${currency}（${pct}%）`;
}

/** 金额格式化（不带币种符号，两位小数千分位）。 */
export function fmtAmount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 人民币金额（带 ¥）。 */
export function fmtCny(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `¥${fmtAmount(n)}`;
}

/** 原币金额（币种在后）。CNY 走 ¥ 前缀，其余走「1,200.00 USD」。 */
export function fmtMoney(n: number, currency: string): string {
  return currency === 'CNY' ? fmtCny(n) : `${fmtAmount(n)} ${currency}`;
}

export interface DiffSummary {
  level: ReconcileDiffLevel;
  label: string;
  /** 徽章配色 class */
  tone: string;
  /** 「账单比系统多 ¥1,234.00（+4.1%）」这一句 */
  text: string;
  /** 这一级该怎么处理，给财务的下一步提示 */
  hint: string;
}

const DIFF_HINT: Record<ReconcileDiffLevel, string> = {
  MATCH: '两边对得上，可以确认账单并安排付款。',
  MINOR: '小额差异，多半是尾数或个别没维护的成本；核一下明细再确认。',
  MAJOR: '差得多，先别付。三种可能：供应商账单开错、系统里成本没维护全、产品没挂供应商。',
  NO_BASIS: '系统侧没有可比的口径——多半是产品还没挂到这家供应商名下，或这类供应商暂无系统成本。',
};

/**
 * 差额一句话总结。level 由后端定（阈值只有后端一份），这里只负责说人话。
 * diffAmountCny 为正 = 供应商要得比系统算的多。
 */
export function diffSummary(
  level: ReconcileDiffLevel,
  diffAmountCny: number | null,
  pct: number | null,
  labelMap: Record<ReconcileDiffLevel, string>,
  toneMap: Record<ReconcileDiffLevel, string>,
): DiffSummary {
  const base = { level, label: labelMap[level], tone: toneMap[level], hint: DIFF_HINT[level] };
  if (diffAmountCny == null) return { ...base, text: '系统侧没有可比金额' };
  const pctText = pct == null ? '' : `（${pct >= 0 ? '+' : ''}${(pct * 100).toFixed(1)}%）`;
  if (Math.abs(diffAmountCny) < 0.005) return { ...base, text: `两边一致${pctText}` };
  const dir = diffAmountCny > 0 ? '账单比系统多' : '账单比系统少';
  return { ...base, text: `${dir} ${fmtCny(Math.abs(diffAmountCny))}${pctText}` };
}

/**
 * 这张账单还能不能登记付款 —— 与后端 canRegisterPayment 同一套判定（三个派生态可付）。
 * 前端照着显隐按钮，真闸在后端；两边同时改。
 */
export function canRegisterPayment(status: SupplierInvoiceStatus): boolean {
  return status === 'CONFIRMED' || status === 'PARTIALLY_PAID' || status === 'PAID';
}

/** 按钮为什么是灰的 —— 直接把原因写出来，别让运营去猜。 */
export function payDisabledReason(status: SupplierInvoiceStatus): string | null {
  if (status === 'DRAFT') return '草稿账单不能付款，先与供应商核对后点「确认账单」';
  if (status === 'DISPUTED') return '有争议的账单已挂起；消除争议改回「已确认」才能付款';
  return null;
}
