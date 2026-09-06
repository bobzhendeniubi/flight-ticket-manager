/**
 * 发票（前台）—— 客户 / 代理自助申请开票，并看自己那几张的进度。
 *
 * ⚠️ 这里的「发票」是给客户开的**真发票**（专票 / 普票 / 收据）。
 *    订单在后台还有一组叫「开票」的勾，那是内部出票进度，前台看不到、也不相干。
 *
 * 可见范围由后端裁：代理只看自己名下（不含下级——抬头和税号是各家自己的事），
 * 客户只看自己申请的。前端不自己判角色。
 *
 * 金额刻意不传：发票金额由服务端按关联订单的应收算，不能由申请方说了算。
 */
import { apiFetch } from './api';

export type InvoiceType = 'VAT_SPECIAL' | 'VAT_GENERAL' | 'RECEIPT';
export type InvoiceRecordStatus = 'REQUESTED' | 'ISSUED' | 'VOID';

export const INVOICE_TYPES: InvoiceType[] = ['VAT_SPECIAL', 'VAT_GENERAL', 'RECEIPT'];

export const INVOICE_TYPE_LABEL: Record<InvoiceType, string> = {
  VAT_SPECIAL: '增值税专用发票',
  VAT_GENERAL: '增值税普通发票',
  RECEIPT: '收据',
};

export const INVOICE_STATUS_LABEL: Record<InvoiceRecordStatus, string> = {
  REQUESTED: '待开具',
  ISSUED: '已开具',
  VOID: '已作废',
};

export const INVOICE_STATUS_CLASS: Record<InvoiceRecordStatus, string> = {
  REQUESTED: 'bg-amber-100 text-amber-800',
  ISSUED: 'bg-emerald-100 text-emerald-700',
  VOID: 'bg-slate-100 text-slate-600',
};

export interface InvoiceRecord {
  id: string;
  title: string;
  taxNo: string | null;
  billingInfo: string | null;
  type: InvoiceType;
  typeLabel: string;
  amountCny: number;
  status: InvoiceRecordStatus;
  statusLabel: string;
  invoiceNo: string | null;
  issuedAt: string | null;
  attachmentUrl: string | null;
  requestNote: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  agentId: string | null;
  agentLabel: string | null;
  requestedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  orders: Array<{ orderId: string; orderNumber: string; amountCny: number }>;
}

export interface RequestInvoiceInput {
  orderIds: string[];
  title: string;
  taxNo?: string | null;
  billingInfo?: string | null;
  type: InvoiceType;
  requestNote?: string | null;
}

export const invoicesApi = {
  list: (token: string) => apiFetch<{ invoices: InvoiceRecord[] }>('/invoices', { token }),

  request: (token: string, body: RequestInvoiceInput) =>
    apiFetch<{ invoice: InvoiceRecord }>('/invoices/requests', { method: 'POST', token, body }),
};

/**
 * 这些订单已经挂着未作废的发票，不能再申请第二张（后端也会拒，这里先把它们标灰，
 * 免得客户勾了半天才被整批退回）。作废之后订单会从这个集合里掉出来，可以重新申请。
 */
export function lockedOrderIds(invoices: InvoiceRecord[]): Set<string> {
  const locked = new Set<string>();
  for (const inv of invoices) {
    if (inv.status === 'VOID') continue;
    for (const o of inv.orders) locked.add(o.orderId);
  }
  return locked;
}
