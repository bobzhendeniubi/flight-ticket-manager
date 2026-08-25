import type { HoldOrderStatus, OrderStatus } from '../lib/api';

export type OrderStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const ORDER_STATUS_META: Record<OrderStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  DRAFT: { label: '草稿', tone: 'neutral' },
  PENDING_PAYMENT: { label: '待支付', tone: 'warning' },
  PAID: { label: '已支付', tone: 'info' },
  PROCESSING: { label: '处理中', tone: 'info' },
  TICKETED: { label: '出票完成', tone: 'success' },
  COMPLETED: { label: '已完成', tone: 'neutral' },
  PAYMENT_TIMEOUT: { label: '超时', tone: 'warning' },
  CANCELLED: { label: '已取消', tone: 'neutral' },
  REFUND_REQUESTED: { label: '退款申请中', tone: 'warning' },
  REFUNDED: { label: '已退款', tone: 'neutral' },
  CHANGE_REQUESTED: { label: '改期申请中', tone: 'warning' },
  CHANGED: { label: '已改期', tone: 'info' },
  FAILED: { label: '出票失败', tone: 'danger' },
};

export const HOLD_STATUS_META: Record<HoldOrderStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  PENDING: { label: '待生效', tone: 'neutral' },
  HOLDING: { label: '占座中', tone: 'success' },
  OVERDUE: { label: '逾期占座', tone: 'warning' },
  FULLY_PAID: { label: '已全款', tone: 'info' },
  CONVERTED: { label: '已转正', tone: 'info' },
  RELEASED: { label: '已释放', tone: 'neutral' },
  CANCELLED: { label: '已取消', tone: 'danger' },
};

const BADGE_CLASS: Record<OrderStatusTone, string> = {
  neutral: 'badge-neutral',
  info: 'badge-info',
  success: 'badge-success',
  warning: 'badge-warning',
  danger: 'badge-danger',
};

export function orderStatusLabel(s: string): string {
  return ORDER_STATUS_META[s as OrderStatus]?.label ?? s;
}

export function orderStatusBadgeClass(s: string): string {
  const tone = ORDER_STATUS_META[s as OrderStatus]?.tone ?? 'neutral';
  return BADGE_CLASS[tone];
}

export function holdStatusLabel(s: string): string {
  return HOLD_STATUS_META[s as HoldOrderStatus]?.label ?? s;
}

export function holdStatusBadgeClass(s: string): string {
  const tone = HOLD_STATUS_META[s as HoldOrderStatus]?.tone ?? 'neutral';
  return BADGE_CLASS[tone];
}
