/**
 * 供应商应付账单路由（挂在 /finances 前缀下）
 *
 *   GET    /finances/supplier-invoices                         列表（供应商/状态/区间过滤）+ 三个合计
 *   GET    /finances/supplier-invoices/:id                     单张（含明细行与付款记录）
 *   POST   /finances/supplier-invoices                         建单
 *   PATCH  /finances/supplier-invoices/:id                     改单头（金额/汇率/状态/附件/备注）
 *   POST   /finances/supplier-invoices/:id/payments            登记付款
 *   DELETE /finances/supplier-invoices/:id/payments/:paymentId 撤销付款（录错了）
 *
 * 闸：requireFinanceAccess（ADMIN 或 STAFF+财务岗），与财务页同权。
 * 每个写入口都留审计——钱付出去的每一步都要查得到是谁在什么时候记的。
 */
import type { FastifyPluginAsync } from 'fastify';
import { SupplierInvoicePeriodKind, SupplierInvoiceStatus } from '@prisma/client';
import { z } from 'zod';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import {
  addSupplierPayment,
  createSupplierInvoice,
  deleteSupplierPayment,
  getSupplierInvoice,
  listSupplierInvoices,
  SUPPLIER_PAY_METHODS,
  updateSupplierInvoice,
} from './supplier-invoices.service.js';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期格式应为 YYYY-MM-DD');
const monthStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u, '月份格式应为 YYYY-MM');
const currencyStr = z.string().regex(/^[A-Za-z]{3}$/u, '币种须为 3 位代码，如 CNY / USD');
const money = z.number().positive().max(99_999_999);
const fxRateSchema = z.number().positive().max(100_000).nullable().optional();

const listQuerySchema = z.object({
  supplierId: z.string().min(1).optional(),
  status: z.nativeEnum(SupplierInvoiceStatus).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const lineSchema = z.object({
  label: z.string().trim().min(1).max(120),
  quantity: z.number().nonnegative().max(999_999).nullable().optional(),
  amount: z.number().max(99_999_999),
  flightScheduleId: z.string().min(1).nullable().optional(),
  hotelBlockPeriodId: z.string().min(1).nullable().optional(),
  orderId: z.string().min(1).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});

const createBodySchema = z.object({
  supplierId: z.string().min(1),
  invoiceNo: z.string().trim().max(80).nullable().optional(),
  periodKind: z.nativeEnum(SupplierInvoicePeriodKind),
  flightScheduleId: z.string().min(1).nullable().optional(),
  periodMonth: monthStr.nullable().optional(),
  periodFrom: dateStr.nullable().optional(),
  periodTo: dateStr.nullable().optional(),
  currency: currencyStr.optional(),
  amount: money,
  fxRate: fxRateSchema,
  // 建单只允许落在人工态；已付清 / 部分付款由付款记录推导，不给手工入口
  status: z
    .enum([
      SupplierInvoiceStatus.DRAFT,
      SupplierInvoiceStatus.CONFIRMED,
      SupplierInvoiceStatus.DISPUTED,
    ])
    .optional(),
  attachmentUrl: z.string().trim().max(500).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  lines: z.array(lineSchema).max(200).optional(),
});

const patchBodySchema = z.object({
  invoiceNo: z.string().trim().max(80).nullable().optional(),
  currency: currencyStr.optional(),
  amount: money.optional(),
  fxRate: fxRateSchema,
  status: z.nativeEnum(SupplierInvoiceStatus).optional(),
  attachmentUrl: z.string().trim().max(500).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

const paymentBodySchema = z.object({
  paidOn: dateStr,
  amount: money,
  fxRate: fxRateSchema,
  method: z.enum(SUPPLIER_PAY_METHODS),
  reference: z.string().trim().max(120).nullable().optional(),
  payerLabel: z.string().trim().max(60).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});

export const supplierInvoiceRoutes: FastifyPluginAsync = async (app) => {
  const requireFinance = { preHandler: [app.authenticate, app.requireFinanceAccess] };

  app.get('/supplier-invoices', requireFinance, async (req) => {
    const q = listQuerySchema.parse(req.query ?? {});
    // 应付账含金额，读也留痕（口径同财务页 VIEW_FINANCES）
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'VIEW_FINANCES',
      targetType: 'SYSTEM',
      targetId: 'supplier-invoices',
      targetLabel: '供应商应付',
      after: q,
    });
    return listSupplierInvoices(q);
  });

  app.get('/supplier-invoices/:id', requireFinance, async (req) => {
    const { id } = req.params as { id: string };
    return { invoice: await getSupplierInvoice(id) };
  });

  app.post('/supplier-invoices', requireFinance, async (req) => {
    const body = createBodySchema.parse(req.body);
    const invoice = await createSupplierInvoice(body, req.user.sub);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CREATE_SUPPLIER_INVOICE',
      targetType: 'SYSTEM',
      targetId: invoice.id,
      targetLabel: `${invoice.supplierName} · ${invoice.periodLabel}`,
      after: {
        amount: invoice.amount,
        currency: invoice.currency,
        amountCny: invoice.amountCny,
        status: invoice.status,
      },
    });
    return { invoice };
  });

  app.patch('/supplier-invoices/:id', requireFinance, async (req) => {
    const { id } = req.params as { id: string };
    const body = patchBodySchema.parse(req.body);
    const before = await getSupplierInvoice(id);
    const invoice = await updateSupplierInvoice(id, body);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_SUPPLIER_INVOICE',
      targetType: 'SYSTEM',
      targetId: id,
      targetLabel: `${invoice.supplierName} · ${invoice.periodLabel}`,
      before: { amount: before.amount, currency: before.currency, status: before.status },
      after: { amount: invoice.amount, currency: invoice.currency, status: invoice.status },
    });
    return { invoice };
  });

  /** 登记一笔实付。超付、草稿单、争议单都会被服务层顶回去（409/400）。 */
  app.post('/supplier-invoices/:id/payments', requireFinance, async (req) => {
    const { id } = req.params as { id: string };
    const body = paymentBodySchema.parse(req.body);
    const invoice = await addSupplierPayment(id, body, req.user.sub);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'ADD_SUPPLIER_PAYMENT',
      targetType: 'SYSTEM',
      targetId: id,
      targetLabel: `${invoice.supplierName} · ${invoice.periodLabel}`,
      after: {
        paidOn: body.paidOn,
        amount: body.amount,
        currency: invoice.currency,
        method: body.method,
        reference: body.reference ?? null,
        paidTotal: invoice.paidAmount,
        status: invoice.status,
      },
    });
    return { invoice };
  });

  /** 撤销一笔录错的付款；状态会跟着退回去（已付清 → 部分付款 / 已确认）。 */
  app.delete('/supplier-invoices/:id/payments/:paymentId', requireFinance, async (req) => {
    const { id, paymentId } = req.params as { id: string; paymentId: string };
    const before = await getSupplierInvoice(id);
    const removed = before.payments.find((p) => p.id === paymentId) ?? null;
    const invoice = await deleteSupplierPayment(id, paymentId);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'DELETE_SUPPLIER_PAYMENT',
      targetType: 'SYSTEM',
      targetId: id,
      targetLabel: `${invoice.supplierName} · ${invoice.periodLabel}`,
      before: removed,
      after: { paidTotal: invoice.paidAmount, status: invoice.status },
    });
    return { invoice };
  });
};
