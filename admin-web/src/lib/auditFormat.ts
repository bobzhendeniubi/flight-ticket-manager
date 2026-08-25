/**
 * 审计日志展示格式化器 — 把后端的 action 代码和 JSON payload 转成人类可读的中文。
 *
 * 后端记录的是结构化数据（action 是 SCREAMING_SNAKE，before/after 是任意 JSON），
 * 前端这层负责翻译。新增 action 时只需在 ACTION_DICT 加一行；
 * 新增 payload 字段在 FIELD_DICT 加一行。
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
};

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
};

export function formatAction(code: string): ActionEntry {
  const hit = ACTION_DICT[code];
  if (hit) return hit;
  // 未登记的 action：把 SNAKE_CASE 转成 "Snake case" 兜底
  const fallback = code.toLowerCase().replace(/_/g, ' ');
  return { label: fallback, icon: 'info' };
}

/** 把任意标量值翻译成易读字符串 */
function formatScalar(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') {
    if (key === 'force') return value ? '是（绕过状态机）' : '否';
    return value ? '是' : '否';
  }
  if (typeof value === 'number') {
    if (/(amount|total|payable|price|balance|offset|revenue|commission)$/i.test(key)) {
      return `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
    }
    if (key === 'rate' || key === 'toRate' || key === 'fromRate') {
      return `${(value * 100).toFixed(2)}%`;
    }
    return value.toLocaleString('zh-CN');
  }
  if (typeof value === 'string') {
    if (/^[A-Z][A-Z_]{1,30}$/.test(value) && ENUM_DICT[value]) {
      return ENUM_DICT[value];
    }
    if (/^-?\d+(\.\d+)?$/.test(value) && /(amount|total|payable|price|balance|offset|revenue|commission)$/i.test(key)) {
      return `¥${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
    }
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 把单边 payload（before 或 after）转成 ["原因: 客户超时未付", ...] 这样的行 */
function formatSide(payload: unknown): string[] {
  if (payload === null || payload === undefined) return [];
  if (typeof payload !== 'object') return [String(payload)];
  const obj = payload as Record<string, unknown>;
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    const label = FIELD_DICT[k] ?? k;
    lines.push(`${label}: ${formatScalar(k, v)}`);
  }
  return lines;
}

export interface DiffLine {
  prefix: '−' | '+' | '·';
  text: string;
  isAdded?: boolean;
  isRemoved?: boolean;
}

/**
 * 计算 before/after 的 diff，返回带前缀的行。
 * - 新建（before 为空）：列 after，前缀 '·'
 * - 删除（after 为空）：列 before，前缀 '−'
 * - 双值变化：合成 "字段: 旧 → 新"
 * - 仅一边出现：'+' 或 '−'
 */
export function formatPayloadDiff(before: unknown, after: unknown): DiffLine[] {
  if (before === null || before === undefined) {
    return formatSide(after).map((text) => ({ prefix: '·', text }));
  }
  if (after === null || after === undefined) {
    return formatSide(before).map((text) => ({ prefix: '−', text, isRemoved: true }));
  }

  if (typeof before === 'object' && typeof after === 'object') {
    const beforeObj = before as Record<string, unknown>;
    const afterObj = after as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
    const lines: DiffLine[] = [];
    for (const k of allKeys) {
      const beforeVal = beforeObj[k];
      const afterVal = afterObj[k];
      if (JSON.stringify(beforeVal) === JSON.stringify(afterVal)) continue;
      const label = FIELD_DICT[k] ?? k;
      const beforeFilled = beforeVal !== undefined && beforeVal !== null && beforeVal !== '';
      const afterFilled = afterVal !== undefined && afterVal !== null && afterVal !== '';
      if (beforeFilled && afterFilled) {
        lines.push({
          prefix: '·',
          text: `${label}: ${formatScalar(k, beforeVal)} → ${formatScalar(k, afterVal)}`,
        });
        continue;
      }
      if (afterFilled) {
        lines.push({ prefix: '+', text: `${label}: ${formatScalar(k, afterVal)}`, isAdded: true });
      } else if (beforeFilled) {
        lines.push({ prefix: '−', text: `${label}: ${formatScalar(k, beforeVal)}`, isRemoved: true });
      }
    }
    return lines;
  }

  return [
    { prefix: '−', text: String(before), isRemoved: true },
    { prefix: '+', text: String(after), isAdded: true },
  ];
}

/** 一句话摘要（用于表格紧凑展示） */
export function summarizePayload(_action: string, before: unknown, after: unknown): string {
  const lines = formatPayloadDiff(before, after);
  if (lines.length === 0) return '—';
  const core = lines.find((l) => l.text.startsWith('目标状态:') || l.text.startsWith('状态:'));
  if (core) {
    const more = lines.length - 1;
    return more > 0 ? `${core.text}（+${more} 项）` : core.text;
  }
  if (lines.length === 1) return lines[0].text;
  return `${lines[0].text}（+${lines.length - 1} 项）`;
}
