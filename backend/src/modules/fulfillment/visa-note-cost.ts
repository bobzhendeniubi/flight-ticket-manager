/**
 * 签证任务备注里的「人均进价」解析（纯函数，无 IO）。
 *
 * 背景：签证任务有结构化的人均成本字段（visaUnitCostUsd / visaFxRate / visaUnitCostCny +
 * visaSupplier）之前，进价一直靠签证岗手写在 notes 里，格式约定俗成是
 * 「<签证公司><金额>美金」，例如「斯玛特31.5美金」「林总54美金」。存量里还有一批这种备注，
 * 需要一次性回填进结构化字段（见 scripts/backfill-visa-task-cost-from-notes.ts）。
 *
 * 本文件只负责「这条备注能不能读出一个确定的人均美金进价」，读不出就返回 null——
 * 回填脚本据此严格区分「能自动回填」与「必须人工核对」，绝不猜。
 */

/** 备注里解析出的一笔人均进价。 */
export interface VisaNoteCost {
  /** 金额前的签证公司名（已去空） */
  supplier: string;
  /** 人均进价（美金），保留两位小数 */
  usd: number;
}

/**
 * 只认「备注**开头**就是 <非数字前缀><金额>美金」这一种写法。
 *
 * - 前缀 `[^\d\s]+`（**非数字、非空白**，至少一个字符）：这是「公司名」。
 *   排除数字是关键——若写成 `\S+?`，「斯玛特35+65美金」会被读成「公司=斯玛特35+、金额=65」，
 *   而那种「35+65」是两段费用相加的人工写法，单人口径不明确，必须交人工，不能自动回填。
 * - 金额后允许任意尾巴（「 · 由订单 … 拆分创建」之类的系统追加说明），不影响取数。
 * - 没有公司名的纯金额备注（「31.5美金」）同样不匹配：回填要能说清这笔钱付给了谁。
 *
 * 已知边界：若有人把叙述紧贴着公司名写在最前面且中间不留空格（「已送签，斯玛特65美金」），
 * 公司名会连着叙述一起读出来。金额仍是对的，公司名则需人工看一眼——回填脚本逐条打印解析出的
 * 公司名与金额，正是为了让这种脏前缀在核对时暴露出来。存量备注里未见此种写法。
 */
const NOTE_COST_RE = /^([^\d\s]+)(\d+(?:\.\d+)?)\s*美金/u;

/** 金额保留两位（避免 31.5 这类输入被浮点尾巴污染）。 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 解析签证任务备注里的人均进价。
 *
 * 读不出确定金额一律返回 null，典型的「读不出」有：
 *   - 「斯玛特35+65美金」   两段相加，单人口径不明
 *   - 「斯玛特免费取消」     没有金额
 *   - 「斯玛特」            只有公司名
 *   - 「自备签证*7  安排前置舱」「录单签证要求为「不需要」…」  根本不是进价备注
 *   - 「0美金」            金额非正数，等同于「没填」，交人工判断是免费还是漏填
 */
export function parseVisaNoteCost(note: string | null | undefined): VisaNoteCost | null {
  if (!note) return null;
  const m = NOTE_COST_RE.exec(note.trim());
  if (!m) return null;

  const supplier = m[1].trim();
  if (supplier === '') return null;

  const usd = round2(Number(m[2]));
  if (!Number.isFinite(usd) || usd <= 0) return null;

  return { supplier, usd };
}

/**
 * 判断 visaSupplier 字段是不是被填成了金额（存量里有一批把「31.5美金」填进了公司名格）。
 * 这类值不是公司名，回填脚本要把它当金额读走、并把公司名换成产品主数据里的签证公司。
 */
export function isAmountOnlySupplier(s: string | null | undefined): boolean {
  if (!s) return false;
  return /^\d+(\.\d+)?\s*(美金|美元|USD)?$/iu.test(s.trim());
}

/**
 * 把「填错格的金额型 visaSupplier」读成美金金额；不是金额型（或非正数）返回 null。
 * 与 {@link isAmountOnlySupplier} 同一判定，供回填脚本直接取数，避免调用方各自 parseFloat。
 */
export function parseAmountOnlySupplier(s: string | null | undefined): number | null {
  if (!isAmountOnlySupplier(s)) return null;
  const usd = round2(Number.parseFloat((s as string).trim()));
  if (!Number.isFinite(usd) || usd <= 0) return null;
  return usd;
}
