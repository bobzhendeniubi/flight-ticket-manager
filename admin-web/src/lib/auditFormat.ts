/**
 * 审计日志展示格式化器 — 把后端的 action 代码和 JSON payload 转成人类可读的中文。
 *
 * 后端记录的是结构化数据（action 是 SCREAMING_SNAKE，before/after 是任意 JSON），
 * 前端这层负责翻译。新增 action 时只需在 ACTION_DICT 加一行；
 * 新增 payload 字段在 FIELD_DICT 加一行。
 *
 * FIELD_DICT 是**全局**字典：note / quantity / leg 这类通用键会命中所有 action，
 * 所以它里面只放放之四海皆准的中性译名。某个 action 下要更精确的说法（如恢复回程的
 * quantity 其实是「座数」）走 ACTION_FIELD_DICT 按 action 覆盖，别去改全局条目
 * ——把全局 quantity 改成「座数」会误伤酒店间数、行项数量这些同名字段。
 */

import type { IconName } from '../components/Icon';

interface ActionEntry {
  label: string;
  icon: IconName;
}

const ACTION_DICT: Record<string, ActionEntry> = {
  // ── 订单 ──
  CREATE_ORDER: { label: '下单', icon: 'ticket' },
  ADVANCE_ORDER_STATUS: { label: '推进订单状态', icon: 'refresh' },
  FORCE_ORDER_STATUS: { label: '强制改订单状态', icon: 'alert' },
  BATCH_ADVANCE_ORDER_STATUS: { label: '批量推进订单状态', icon: 'refresh' },
  BATCH_FORCE_ORDER_STATUS: { label: '批量强制改状态', icon: 'alert' },
  REQUEST_CANCELLATION: { label: '申请取消订单', icon: 'alert' },
  RESEND_ITINERARY: { label: '重发行程单', icon: 'mail' },
  MARK_NO_SHOW: { label: '标记去程 no-show', icon: 'alert' },
  RESTORE_RETURN_LEG: { label: '恢复回程', icon: 'refresh' },
  RESTORE_RETURN_LEG_OVERSOLD: { label: '恢复回程（超售放行）', icon: 'alert' },
  RESTORE_RETURN_LEG_DISPLACED_RESERVATION: { label: '恢复回程（挤占预留座）', icon: 'alert' },
  VOID_RETURN_LEG: { label: '作废回程', icon: 'plane' },
  CANCEL_RETURN_LEG: { label: '取消回程', icon: 'plane' },
  CANCEL_OUTBOUND_LEG: { label: '取消去程', icon: 'plane' },

  // ── 支付 ──
  CREATE_PAYMENT: { label: '创建支付', icon: 'wallet' },
  PAYMENT_SUCCEEDED: { label: '支付成功', icon: 'check' },
  PAYMENT_CALLBACK_REJECTED: { label: '支付回调被拒', icon: 'alert' },
  MINIAPP_PREPAY: { label: '小程序预支付', icon: 'wallet' },

  // ── 履约 ──
  REISSUE_FULFILLMENT_TASK: { label: '重新执行履约任务', icon: 'refresh' },
  UPDATE_FULFILLMENT_TASK: { label: '更新履约任务', icon: 'package' },

  // ── 结算 ──
  ADVANCE_SETTLEMENT_STATUS: { label: '推进结算单状态', icon: 'wallet' },

  // ── 代理 ──
  CREATE_AGENT: { label: '创建代理', icon: 'handshake' },
  UPDATE_AGENT: { label: '更新代理', icon: 'handshake' },
  DELETE_AGENT: { label: '删除代理', icon: 'trash' },

  // ── 出行人 ──
  CREATE_TRAVELER: { label: '创建出行人', icon: 'user' },
  UPDATE_TRAVELER: { label: '更新出行人', icon: 'user' },
  DELETE_TRAVELER: { label: '删除出行人', icon: 'trash' },

  // ── 客户 ──
  UPDATE_CUSTOMER: { label: '更新客户资料', icon: 'users' },

  // ── 定价 ──
  UPDATE_PRICING: { label: '更新定价规则', icon: 'wallet' },
  OVERRIDE_DATE_RANKING: { label: '覆盖日期等级', icon: 'calendar' },
  RESET_DATE_RANKING: { label: '重置日期等级', icon: 'refresh' },

  // ── 退订政策 ──
  CREATE_CANCELLATION_POLICY: { label: '新增退订政策', icon: 'clipboard' },
  UPDATE_CANCELLATION_POLICY: { label: '更新退订政策', icon: 'clipboard' },
  DELETE_CANCELLATION_POLICY: { label: '删除退订政策', icon: 'trash' },
};

/** 单字段 → 中文标签 */
const FIELD_DICT: Record<string, string> = {
  toStatus: '目标状态',
  fromStatus: '原状态',
  reason: '原因',
  force: '强制模式',
  requestedCount: '请求条数',
  successCount: '成功',
  failureCount: '失败',
  payable: '应付金额',
  amount: '金额',
  total: '订单金额',
  rate: '佣金率',
  baseAmount: '计提基数',
  itemCount: '行项数',
  passengerCount: '乘客数',
  prepaymentBalance: '预付余额',
  notes: '备注',
  email: '邮箱',
  phone: '电话',
  contactName: '联系人',
  companyName: '公司名',
  tier: '层级',
  productKind: '产品类型',
  cabin: '舱位',
  flightNumber: '航班号',
  date: '日期',
  rank: '等级',
  scheduleId: '航班 ID',
  policyId: '政策 ID',
  ruleId: '规则 ID',
  toRate: '新佣金率',
  fromRate: '原佣金率',
  // ── 代理 ──
  agentName: '代理',
  agentBalanceAfter: '代理余额（变更后）',
  usedAgentBalance: '使用代理余额',
  targetAgentId: '目标代理',
  // ── 调价 / 结算价 ──
  amountCny: '金额',
  reasonCode: '原因',
  reasonText: '原因说明',
  reasonLabel: '原因',
  passengerId: '乘客',
  passengerName: '乘客',
  itemId: '行项 ID',
  orderItemId: '订单行 ID',
  discountCny: '优惠金额',
  subtotalCny: '小计',
  settlementTotalCny: '结算总价',
  settlementPriceCny: '结算价',
  diffCny: '差额',
  revokedCny: '撤销金额',
  feeCny: '费用',
  // ── 收款 / 进账 ──
  method: '收款方式',
  fullyPaid: '已付清',
  hasProof: '含凭证',
  creditedToOrder: '入账本单',
  movedToPool: '转入挂账池',
  poolReceiptNo: '挂账单号',
  receiptNo: '进账单号',
  receiptId: '进账 ID',
  receiptStatus: '进账状态',
  paymentId: '支付 ID',
  reversedAmount: '冲销金额',
  reversalId: '冲销 ID',
  orderBalanceDue: '应收余额',
  orderPaidAmount: '订单已收',
  orderFullyPaid: '订单已付清',
  orderStatus: '订单状态',
  newPaidAmount: '新已收金额',
  expectedAmountCny: '预期到账金额',
  confirmedAmountCny: '确认金额',
  receivedAmount: '实收金额',
  // ── no-show / 航段取消 / 恢复回程 ──
  // 通用键（leg / quantity / note / source）在这里只给中性译名，精确说法见 ACTION_FIELD_DICT。
  leg: '航段',
  outboundItemId: '去程行 ID',
  returnItemId: '航段行 ID',
  releasedSeats: '释放座位',
  releaseReturn: '释放回程',
  passengerIds: '涉及乘客',
  workOrderReminderId: '关联工单',
  split: '拆单',
  sourceOrderNumber: '源单号',
  targetOrderNumber: '新单号',
  note: '备注',
  replayed: '幂等回放',
  oversold: '超售放行',
  oversoldBy: '超售座位数',
  maxOversell: '超售上限',
  // 恢复回程占座的两个来源分开记：挤占的是别人预留的座（物理上有座），物理超售是真卖穿了。
  displacedReserved: '挤占预留座数',
  physicalIncrement: '物理超售座数',
  quantity: '数量',
  source: '来源',
  acknowledgedWarnings: '已确认警告',
  feeMode: '手续费模式',
  policyName: '退订政策',
  overrideReason: '手工覆盖原因',
  originalAmountCny: '原航段金额',
  netReductionCny: '应收降低额',
  totalCny: '订单总额',
  overpayAfterCny: '取消后多收额',
};

/**
 * 按 action 覆盖的字段标签：只在这些 action 的 payload 里生效，命中不到就回落 FIELD_DICT。
 * 存在的意义是让通用键（leg/quantity/note/source）在 no-show 与航段取消这条链路上说人话，
 * 同时不污染其它 action 对同名键的语义。
 */
const ACTION_FIELD_DICT: Record<string, Record<string, string>> = {
  MARK_NO_SHOW: {
    leg: '航段方向',
    quantity: '座数',
    note: '处理备注',
    source: '标记来源',
  },
  RESTORE_RETURN_LEG: {
    leg: '航段方向',
    quantity: '恢复座数',
    note: '处理备注',
  },
  RESTORE_RETURN_LEG_OVERSOLD: {
    leg: '航段方向',
    quantity: '恢复座数',
    note: '处理备注',
  },
  RESTORE_RETURN_LEG_DISPLACED_RESERVATION: {
    leg: '航段方向',
    quantity: '恢复座数',
    note: '处理备注',
  },
  VOID_RETURN_LEG: {
    leg: '航段方向',
    quantity: '座数',
    note: '处理备注',
  },
  CANCEL_RETURN_LEG: {
    leg: '航段方向',
    quantity: '座数',
    note: '处理备注',
  },
  CANCEL_OUTBOUND_LEG: {
    leg: '航段方向',
    quantity: '座数',
    note: '处理备注',
  },
};

/** 字段标签查找：action 覆盖 > 全局字典 > 原样键名。 */
function fieldLabel(key: string, action?: string): string {
  if (action) {
    const scoped = ACTION_FIELD_DICT[action]?.[key];
    if (scoped) return scoped;
  }
  return FIELD_DICT[key] ?? key;
}

/** OrderStatus / SettlementStatus / 其他后端枚举 → 中文 */
const ENUM_DICT: Record<string, string> = {
  // OrderStatus
  DRAFT: '草稿',
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  PROCESSING: '处理中',
  TICKETED: '出票完成',
  COMPLETED: '已完成',
  PAYMENT_TIMEOUT: '支付超时',
  CANCELLED: '已取消',
  REFUND_REQUESTED: '退款申请中',
  REFUNDED: '已退款',
  CHANGE_REQUESTED: '改期申请中',
  CHANGED: '已改期',
  FAILED: '出票失败',
  // SettlementStatus
  PENDING_APPROVAL: '待审批',
  APPROVED: '已核准',
  VOIDED: '已作废',
  // CommissionStatus
  ACCRUED: '已计提',
  SETTLEMENT_REQUESTED: '已申请结算',
  SETTLED: '已结算',
  REVERSED: '已冲销',
  // ProductKind
  FLIGHT: '机票',
  HOTEL: '酒店',
  TRANSFER: '地面服务',
  VISA: '签证',
  INSURANCE: '保险',
  BUNDLE: '套餐',
  // CabinClass
  ECONOMY: '经济舱',
  PREMIUM_ECONOMY: '超级经济舱',
  BUSINESS: '商务舱',
  FIRST: '头等舱',
  // DateRanking
  A: 'A 黄金日',
  B: 'B 高峰日',
  C: 'C 平峰日',
  D: 'D 优惠日',
  // FlightLegSide（取消 / 恢复航段方向）
  OUTBOUND: '去程',
  RETURN: '回程',
  // 取消航段手续费模式
  POLICY: '按政策',
  MANUAL: '手工覆盖',
};

/**
 * 按**字段名**覆盖的枚举译名：同一个枚举值在不同字段下不是一个意思。
 * 典型是 MANUAL——在 feeMode 上是「手工覆盖（政策价）」，在 no-show 的 source 上却是
 * 「人工标记（相对航司名单自动导入）」，全局一份字典必然把其中一边翻错。
 */
const FIELD_ENUM_DICT: Record<string, Record<string, string>> = {
  source: {
    MANUAL: '人工标记',
  },
};

export function formatAction(code: string): ActionEntry {
  const hit = ACTION_DICT[code];
  if (hit) return hit;
  // 未登记的 action：把 SNAKE_CASE 转成 "Snake case" 兜底
  const fallback = code.toLowerCase().replace(/_/g, ' ');
  return { label: fallback, icon: 'info' };
}

// 金额字段名后缀：本体（amount/total/...）后面可以再跟一个 Cny（amountCny/feeCny/diffCny 等
// 新代码的记账惯例），两种写法都按人民币格式化。
const MONEY_KEY_RE = /(amount|total|payable|price|balance|offset|revenue|commission|fee|diff|due|discount)(cny)?$/i;

/** 把任意标量值翻译成易读字符串。action 只用于挑更精确的字段标签/枚举译名，可不传。 */
function formatScalar(key: string, value: unknown, action?: string): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') {
    if (key === 'force') return value ? '是（绕过状态机）' : '否';
    return value ? '是' : '否';
  }
  if (typeof value === 'number') {
    if (MONEY_KEY_RE.test(key)) {
      return `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
    }
    if (key === 'rate' || key === 'toRate' || key === 'fromRate') {
      return `${(value * 100).toFixed(2)}%`;
    }
    return value.toLocaleString('zh-CN');
  }
  if (typeof value === 'string') {
    if (/^[A-Z][A-Z_]{1,30}$/.test(value)) {
      // 字段级译名优先：MANUAL 在 feeMode 上是「手工覆盖」，在 source 上是「人工标记」。
      const scoped = FIELD_ENUM_DICT[key]?.[value];
      if (scoped) return scoped;
      if (ENUM_DICT[value]) return ENUM_DICT[value];
    }
    if (/^-?\d+(\.\d+)?$/.test(value) && MONEY_KEY_RE.test(key)) {
      return `¥${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    // releasedSeats 这类对象数组（{scheduleId, cabin, quantity}）：渲染成
    // 「经济舱 2 座 / 商务舱 1 座」这类人话，别整段 dump JSON。
    if (key === 'releasedSeats') {
      return value
        .map((seat) => {
          const s = seat as { cabin?: string; quantity?: number };
          const cabinLabel = (s.cabin && ENUM_DICT[s.cabin]) ?? s.cabin ?? '未知舱位';
          return `${cabinLabel} ${s.quantity ?? 0} 座`;
        })
        .join(' / ');
    }
    // 纯 id 数组（如 passengerIds）：裸 id 列表没意义，只报数量。
    if (/Ids$/.test(key) && value.every((v) => typeof v === 'string')) {
      return `${value.length} 位`;
    }
    if (value.every((v) => v === null || typeof v !== 'object')) {
      return value.map((v) => formatScalar(key, v, action)).join('、');
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  if (typeof value === 'object') {
    // 普通嵌套对象（如 split{sourceOrderNumber,targetOrderNumber}）：逐字段拼成一行，
    // 复用同一份 FIELD_DICT/formatScalar，别为嵌套对象另起一套格式化逻辑。
    const obj = value as Record<string, unknown>;
    const parts = Object.entries(obj)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${fieldLabel(k, action)}: ${formatScalar(k, v, action)}`);
    if (parts.length > 0) return parts.join('，');
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// 某键以 Id 结尾（agentId/passengerId/...），且同一份 payload 里存在对应的 xxxName/xxxLabel
// 键时，Id 行只是噪音——真正有用的名字已经单独一行了，跳过它别把摘要行挤成一堆裸 id。
function isIdKey(key: string): boolean {
  return key.length > 2 && key.endsWith('Id');
}

function hasCompanionLabel(obj: Record<string, unknown> | undefined, key: string): boolean {
  if (!obj || !isIdKey(key)) return false;
  const base = key.slice(0, -2); // 去掉尾部 "Id"
  for (const suffix of ['Name', 'Label']) {
    const v = obj[`${base}${suffix}`];
    if (v !== undefined && v !== null && v !== '') return true;
  }
  return false;
}

/** 把单边 payload（before 或 after）转成 ["原因: 客户超时未付", ...] 这样的行。
 * 非 Id 行在前；没有对应 name/label 的裸 Id 行保留但放到最后；有对应 name/label 的 Id 行整条跳过。 */
function formatSide(payload: unknown, action?: string): string[] {
  if (payload === null || payload === undefined) return [];
  if (typeof payload !== 'object') return [String(payload)];
  const obj = payload as Record<string, unknown>;
  const otherLines: string[] = [];
  const idLines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    if (hasCompanionLabel(obj, k)) continue;
    const label = fieldLabel(k, action);
    const line = `${label}: ${formatScalar(k, v, action)}`;
    (isIdKey(k) ? idLines : otherLines).push(line);
  }
  return [...otherLines, ...idLines];
}

export interface DiffLine {
  prefix: '−' | '+' | '·';
  text: string;
  isAdded?: boolean;
  isRemoved?: boolean;
}

/**
 * 计算 before/after 的 diff，返回带前缀的行。传 action 时字段标签走该 action 的精确译名。
 * - 新建（before 为空）：列 after，前缀 '·'
 * - 删除（after 为空）：列 before，前缀 '−'
 * - 双值变化：合成 "字段: 旧 → 新"
 * - 仅一边出现：'+' 或 '−'
 */
export function formatPayloadDiff(before: unknown, after: unknown, action?: string): DiffLine[] {
  if (before === null || before === undefined) {
    return formatSide(after, action).map((text) => ({ prefix: '·', text }));
  }
  if (after === null || after === undefined) {
    return formatSide(before, action).map((text) => ({ prefix: '−', text, isRemoved: true }));
  }

  if (typeof before === 'object' && typeof after === 'object') {
    const beforeObj = before as Record<string, unknown>;
    const afterObj = after as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
    // 非 Id 行在前，裸 Id（无对应 name/label）行放最后——摘要只取第一行时才不会被 id 抢位。
    const otherLines: DiffLine[] = [];
    const idLines: DiffLine[] = [];
    for (const k of allKeys) {
      const beforeVal = beforeObj[k];
      const afterVal = afterObj[k];
      if (JSON.stringify(beforeVal) === JSON.stringify(afterVal)) continue;
      // 有对应 xxxName/xxxLabel 键（任一边）时，这条 Id 行是噪音，跳过——真正有用的名字自成一行。
      if (hasCompanionLabel(beforeObj, k) || hasCompanionLabel(afterObj, k)) continue;
      const label = fieldLabel(k, action);
      const beforeFilled = beforeVal !== undefined && beforeVal !== null && beforeVal !== '';
      const afterFilled = afterVal !== undefined && afterVal !== null && afterVal !== '';
      const bucket = isIdKey(k) ? idLines : otherLines;
      if (beforeFilled && afterFilled) {
        bucket.push({
          prefix: '·',
          text: `${label}: ${formatScalar(k, beforeVal, action)} → ${formatScalar(k, afterVal, action)}`,
        });
        continue;
      }
      if (afterFilled) {
        bucket.push({ prefix: '+', text: `${label}: ${formatScalar(k, afterVal, action)}`, isAdded: true });
      } else if (beforeFilled) {
        bucket.push({ prefix: '−', text: `${label}: ${formatScalar(k, beforeVal, action)}`, isRemoved: true });
      }
    }
    return [...otherLines, ...idLines];
  }

  return [
    { prefix: '−', text: String(before), isRemoved: true },
    { prefix: '+', text: String(after), isAdded: true },
  ];
}

/** 一句话摘要（用于表格紧凑展示） */
export function summarizePayload(action: string, before: unknown, after: unknown): string {
  const lines = formatPayloadDiff(before, after, action);
  if (lines.length === 0) return '—';
  const core = lines.find((l) => l.text.startsWith('目标状态:') || l.text.startsWith('状态:'));
  if (core) {
    const more = lines.length - 1;
    return more > 0 ? `${core.text}（+${more} 项）` : core.text;
  }
  if (lines.length === 1) return lines[0].text;
  return `${lines[0].text}（+${lines.length - 1} 项）`;
}
