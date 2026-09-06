/**
 * 供应商应付 + 发票 的 API 客户端与类型。
 *
 * ⚠️ 这里的「发票」是给客户 / 代理开的**真发票**（专票 / 普票 / 收据）。
 *    订单上的「开票」三个勾（去程 / 回程 / 系统）是票务岗的**出票进度**，与此无关，
 *    两边互不联动 —— 只是中文撞了名字。改这个文件时别顺手去动那三个勾。
 *
 * 单独成文件而不是塞进 lib/api.ts：那个文件已经 8000 多行，再往里堆只会更难找。
 * 底层仍复用 api.ts 的 apiFetch（同一套鉴权 / 刷新 / 错误封装）。
 */
import { apiFetch } from './api';

// ── 供应商 ───────────────────────────────────────────────────────────────────

export type SupplierType = 'AIRLINE' | 'HOTEL' | 'VISA_AGENCY' | 'TRANSFER' | 'OTHER';

export const SUPPLIER_TYPE_LABEL: Record<SupplierType, string> = {
  AIRLINE: '航司 / 包机方',
  HOTEL: '酒店 / 地接',
  VISA_AGENCY: '签证公司',
  TRANSFER: '车队 / 地面服务',
  OTHER: '其他',
};

export const SUPPLIER_TYPES: SupplierType[] = [
  'AIRLINE',
  'HOTEL',
  'VISA_AGENCY',
  'TRANSFER',
  'OTHER',
];

export interface Supplier {
  id: string;
  type: SupplierType;
  typeLabel: string;
  name: string;
  currency: string;
  contactName: string | null;
  contactPhone: string | null;
  note: string | null;
  isActive: boolean;
  linkedCounts: { hotels: number; visas: number; flights: number };
  createdAt: string;
  updatedAt: string;
}

export interface SupplierWriteInput {
  type: SupplierType;
  name: string;
  currency?: string;
  contactName?: string | null;
  contactPhone?: string | null;
  note?: string | null;
  isActive?: boolean;
}

// ── 应付账单 ─────────────────────────────────────────────────────────────────

export type SupplierInvoicePeriodKind = 'FLIGHT_SCHEDULE' | 'MONTH' | 'CUSTOM';
export type SupplierInvoiceStatus =
  | 'DRAFT'
  | 'CONFIRMED'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'DISPUTED';
export type SupplierPayMethod = 'BANK' | 'WECHAT' | 'ALIPAY' | 'CASH' | 'OTHER';

export const SUPPLIER_INVOICE_STATUS_LABEL: Record<SupplierInvoiceStatus, string> = {
  DRAFT: '草稿',
  CONFIRMED: '已确认',
  PARTIALLY_PAID: '部分付款',
  PAID: '已付清',
  DISPUTED: '有争议',
};

/** 状态徽章配色（复用 Console 的 badge-* 体系）：欠着钱琥珀、付清绿、争议玫红。 */
export const SUPPLIER_INVOICE_STATUS_TONE: Record<SupplierInvoiceStatus, string> = {
  DRAFT: 'badge-neutral',
  CONFIRMED: 'badge-warning',
  PARTIALLY_PAID: 'badge-warning',
  PAID: 'badge-success',
  DISPUTED: 'badge-danger',
};

export const SUPPLIER_PAY_METHODS: SupplierPayMethod[] = [
  'BANK',
  'WECHAT',
  'ALIPAY',
  'CASH',
  'OTHER',
];

export const SUPPLIER_PAY_METHOD_LABEL: Record<SupplierPayMethod, string> = {
  BANK: '银行转账',
  WECHAT: '微信',
  ALIPAY: '支付宝',
  CASH: '现金',
  OTHER: '其他',
};

export interface SupplierPaymentRow {
  id: string;
  paidOn: string;
  amount: number;
  fxRate: number | null;
  amountCny: number;
  method: string;
  methodLabel: string;
  reference: string | null;
  payerLabel: string | null;
  note: string | null;
  createdAt: string;
}

export interface SupplierInvoiceLineRow {
  id: string;
  label: string;
  quantity: number | null;
  amount: number;
  amountCny: number;
  flightScheduleId: string | null;
  hotelBlockPeriodId: string | null;
  orderId: string | null;
  note: string | null;
}

export interface SupplierInvoice {
  id: string;
  supplierId: string;
  supplierName: string;
  supplierTypeLabel: string;
  invoiceNo: string | null;
  periodKind: SupplierInvoicePeriodKind;
  periodKindLabel: string;
  periodLabel: string;
  flightScheduleId: string | null;
  periodMonth: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  currency: string;
  amount: number;
  fxRate: number | null;
  amountCny: number;
  paidAmount: number;
  paidAmountCny: number;
  outstandingAmount: number;
  status: SupplierInvoiceStatus;
  statusLabel: string;
  attachmentUrl: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  payments: SupplierPaymentRow[];
  lines: SupplierInvoiceLineRow[];
}

export interface SupplierInvoiceListResult {
  rows: SupplierInvoice[];
  outstandingCny: number;
  totalCny: number;
  paidCny: number;
}

export interface SupplierInvoiceCreateInput {
  supplierId: string;
  invoiceNo?: string | null;
  periodKind: SupplierInvoicePeriodKind;
  flightScheduleId?: string | null;
  periodMonth?: string | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  currency?: string;
  amount: number;
  fxRate?: number | null;
  status?: 'DRAFT' | 'CONFIRMED' | 'DISPUTED';
  attachmentUrl?: string | null;
  note?: string | null;
}

export interface SupplierPaymentInput {
  paidOn: string;
  amount: number;
  fxRate?: number | null;
  method: SupplierPayMethod;
  reference?: string | null;
  payerLabel?: string | null;
  note?: string | null;
}

// ── 对账 ─────────────────────────────────────────────────────────────────────

export type ReconcileDiffLevel = 'MATCH' | 'MINOR' | 'MAJOR' | 'NO_BASIS';

export const DIFF_LEVEL_LABEL: Record<ReconcileDiffLevel, string> = {
  MATCH: '对得上',
  MINOR: '小差异',
  MAJOR: '差异较大',
  NO_BASIS: '无系统侧口径',
};

export const DIFF_LEVEL_TONE: Record<ReconcileDiffLevel, string> = {
  MATCH: 'badge-success',
  MINOR: 'badge-warning',
  MAJOR: 'badge-danger',
  NO_BASIS: 'badge-neutral',
};

export interface ReconcileLine {
  label: string;
  quantity: number | null;
  unit: string | null;
  amountCny: number;
  detail: string | null;
}

export interface SupplierInvoiceReconcile {
  invoice: SupplierInvoice;
  systemSide: {
    basis: SupplierType;
    basisLabel: string;
    lines: ReconcileLine[];
    totalCny: number | null;
    sourceCurrency: string | null;
    sourceAmount: number | null;
    missingCostCount: number;
    notes: string[];
  };
  diff: { amountCny: number | null; pct: number | null; level: ReconcileDiffLevel };
}

// ── 发票（真发票，非「开票」三个勾）──────────────────────────────────────────

export type InvoiceType = 'VAT_SPECIAL' | 'VAT_GENERAL' | 'RECEIPT';
export type InvoiceRecordStatus = 'REQUESTED' | 'ISSUED' | 'VOID';

export const INVOICE_TYPES: InvoiceType[] = ['VAT_SPECIAL', 'VAT_GENERAL', 'RECEIPT'];

export const INVOICE_TYPE_LABEL: Record<InvoiceType, string> = {
  VAT_SPECIAL: '增值税专用发票',
  VAT_GENERAL: '增值税普通发票',
  RECEIPT: '收据',
};

export const INVOICE_RECORD_STATUS_LABEL: Record<InvoiceRecordStatus, string> = {
  REQUESTED: '待开具',
  ISSUED: '已开具',
  VOID: '已作废',
};

export const INVOICE_RECORD_STATUS_TONE: Record<InvoiceRecordStatus, string> = {
  REQUESTED: 'badge-warning',
  ISSUED: 'badge-success',
  VOID: 'badge-neutral',
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

// ── 客户端 ───────────────────────────────────────────────────────────────────

function qs(params: Record<string, string | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const supplierPayablesApi = {
  listSuppliers: (
    token: string,
    query: { type?: SupplierType; isActive?: boolean; q?: string } = {},
  ) => apiFetch<{ suppliers: Supplier[] }>(`/finances/suppliers${qs(query)}`, { token }),

  createSupplier: (token: string, body: SupplierWriteInput) =>
    apiFetch<{ supplier: Supplier }>('/finances/suppliers', { method: 'POST', token, body }),

  updateSupplier: (token: string, id: string, body: Partial<SupplierWriteInput>) =>
    apiFetch<{ supplier: Supplier }>(`/finances/suppliers/${encodeURIComponent(id)}`, { method: 'PATCH', token, body }),

  /** 给酒店 / 签证产品 / 航班挂或解挂供应商（supplierId=null 解挂）。 */
  linkProductSupplier: (
    token: string,
    body: { product: 'hotel' | 'visa' | 'flight'; productId: string; supplierId: string | null },
  ) =>
    apiFetch<{ product: string; productId: string; supplierId: string | null }>(
      '/finances/suppliers/link',
      { method: 'PUT', token, body },
    ),

  listInvoices: (
    token: string,
    query: { supplierId?: string; status?: SupplierInvoiceStatus; from?: string; to?: string } = {},
  ) => apiFetch<SupplierInvoiceListResult>(`/finances/supplier-invoices${qs(query)}`, { token }),

  getInvoice: (token: string, id: string) =>
    apiFetch<{ invoice: SupplierInvoice }>(`/finances/supplier-invoices/${encodeURIComponent(id)}`, { token }),

  createInvoice: (token: string, body: SupplierInvoiceCreateInput) =>
    apiFetch<{ invoice: SupplierInvoice }>('/finances/supplier-invoices', {
      method: 'POST',
      token,
      body,
    }),

  updateInvoice: (
    token: string,
    id: string,
    body: {
      invoiceNo?: string | null;
      amount?: number;
      fxRate?: number | null;
      status?: SupplierInvoiceStatus;
      attachmentUrl?: string | null;
      note?: string | null;
    },
  ) =>
    apiFetch<{ invoice: SupplierInvoice }>(`/finances/supplier-invoices/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      token,
      body,
    }),

  addPayment: (token: string, id: string, body: SupplierPaymentInput) =>
    apiFetch<{ invoice: SupplierInvoice }>(`/finances/supplier-invoices/${encodeURIComponent(id)}/payments`, {
      method: 'POST',
      token,
      body,
    }),

  deletePayment: (token: string, id: string, paymentId: string) =>
    apiFetch<{ invoice: SupplierInvoice }>(
      `/finances/supplier-invoices/${encodeURIComponent(id)}/payments/${encodeURIComponent(paymentId)}`,
      { method: 'DELETE', token },
    ),

  /** 对账：系统侧成本 vs 供应商账单，只读。 */
  reconcile: (token: string, id: string) =>
    apiFetch<SupplierInvoiceReconcile>(`/finances/supplier-invoices/${encodeURIComponent(id)}/reconcile`, { token }),
};

export const invoicesApi = {
  list: (
    token: string,
    query: { status?: InvoiceRecordStatus; type?: InvoiceType; orderNumber?: string } = {},
  ) => apiFetch<{ invoices: InvoiceRecord[] }>(`/invoices${qs(query)}`, { token }),

  /** 申请开票。金额由服务端按订单应收算，前端不传也不该传。 */
  request: (
    token: string,
    body: {
      orderIds: string[];
      title: string;
      taxNo?: string | null;
      billingInfo?: string | null;
      type: InvoiceType;
      requestNote?: string | null;
    },
  ) => apiFetch<{ invoice: InvoiceRecord }>('/invoices/requests', { method: 'POST', token, body }),

  issue: (
    token: string,
    id: string,
    body: { invoiceNo: string; issuedAt?: string; attachmentUrl?: string | null },
  ) =>
    apiFetch<{ invoice: InvoiceRecord }>(`/invoices/${encodeURIComponent(id)}/issue`, { method: 'POST', token, body }),

  void: (token: string, id: string, reason: string) =>
    apiFetch<{ invoice: InvoiceRecord }>(`/invoices/${encodeURIComponent(id)}/void`, {
      method: 'POST',
      token,
      body: { reason },
    }),
};
