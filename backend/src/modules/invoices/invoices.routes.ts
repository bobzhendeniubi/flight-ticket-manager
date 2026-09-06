/**
 * 发票路由（真发票：增值税专票 / 普票 / 收据）
 *
 *   GET  /invoices              列表（RBAC 裁剪：财务全量、代理只看自家、客户只看自己申请的）
 *   GET  /invoices/:id          单张
 *   POST /invoices/requests     申请开票（代理 / 客户只能挑自家订单；财务可代任意订单申请）
 *   POST /invoices/:id/issue    开具（财务）
 *   POST /invoices/:id/void     作废（财务，必须填原因）
 *
 * ⚠️ 与订单上的「开票」三个布尔位（出票进度）无关，本路由不读也不写它们。
 *
 * 闸：申请与查询任意登录用户（服务层按角色裁范围）；开具 / 作废走能力 invoices.issue，
 * 与财务页同权 —— 谁能看毛利，谁才能开票号。
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { InvoiceRecordStatus, InvoiceType, UserRole } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import {
  getInvoice,
  issueInvoice,
  listInvoices,
  requestInvoice,
  voidInvoice,
  type InvoiceRequester,
} from './invoices.service.js';

const listQuerySchema = z.object({
  status: z.nativeEnum(InvoiceRecordStatus).optional(),
  type: z.nativeEnum(InvoiceType).optional(),
  orderNumber: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const requestBodySchema = z.object({
  orderIds: z.array(z.string().min(1)).min(1).max(50),
  title: z.string().trim().min(1, '发票抬头不能为空').max(120),
  taxNo: z.string().trim().max(40).nullable().optional(),
  billingInfo: z.string().trim().max(300).nullable().optional(),
  type: z.nativeEnum(InvoiceType),
  requestNote: z.string().trim().max(300).nullable().optional(),
  // 刻意不收 amount：发票金额由服务端按订单应收算，不能由申请方说了算
});

const issueBodySchema = z.object({
  invoiceNo: z.string().trim().min(1, '发票号不能为空').max(60),
  issuedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u, '开具日格式应为 YYYY-MM-DD')
    .optional(),
  attachmentUrl: z.string().trim().max(500).nullable().optional(),
});

const voidBodySchema = z.object({
  reason: z.string().trim().min(1, '作废发票必须填原因').max(300),
});

/** 与 settlements / agent-statements 同款：AGENT 角色时把登录账号解析成自己的 agentId。 */
async function buildRequester(req: FastifyRequest): Promise<InvoiceRequester> {
  let agentId: string | undefined;
  if (req.user.role === UserRole.AGENT) {
    const agent = await prisma.agent.findUnique({
      where: { userId: req.user.sub },
      select: { id: true },
    });
    agentId = agent?.id;
  }
  return { userId: req.user.sub, role: req.user.role, agentId };
}

export const invoiceRoutes: FastifyPluginAsync = async (app) => {
  const requireLogin = { preHandler: [app.authenticate] };
  const requireFinance = { preHandler: [app.authenticate, app.requireCapability('invoices.issue')] };

  app.get('/', requireLogin, async (req) => {
    const q = listQuerySchema.parse(req.query ?? {});
    const requester = await buildRequester(req);
    return { invoices: await listInvoices(requester, q) };
  });

  app.get('/:id', requireLogin, async (req) => {
    const { id } = req.params as { id: string };
    const requester = await buildRequester(req);
    return { invoice: await getInvoice(id, requester) };
  });

  /** 申请开票。归属闸在服务层 assertOrdersOwned：代理 / 客户只能挑自家订单，有一张不是就整批拒。 */
  app.post('/requests', requireLogin, async (req) => {
    const body = requestBodySchema.parse(req.body);
    const requester = await buildRequester(req);
    const invoice = await requestInvoice(body, requester);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'REQUEST_INVOICE',
      targetType: 'ORDER',
      targetId: invoice.orders[0]?.orderId ?? invoice.id,
      targetLabel: invoice.orders.map((o) => o.orderNumber).join('、'),
      after: {
        invoiceId: invoice.id,
        title: invoice.title,
        type: invoice.type,
        amountCny: invoice.amountCny,
        orderCount: invoice.orders.length,
      },
    });
    return { invoice };
  });

  app.post('/:id/issue', requireFinance, async (req) => {
    const { id } = req.params as { id: string };
    const body = issueBodySchema.parse(req.body);
    const invoice = await issueInvoice(id, body, req.user.sub);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'ISSUE_INVOICE',
      targetType: 'SYSTEM',
      targetId: id,
      targetLabel: `发票 ${invoice.invoiceNo ?? id}`,
      after: {
        invoiceNo: invoice.invoiceNo,
        issuedAt: invoice.issuedAt,
        amountCny: invoice.amountCny,
        orders: invoice.orders.map((o) => o.orderNumber),
      },
    });
    return { invoice };
  });

  app.post('/:id/void', requireFinance, async (req) => {
    const { id } = req.params as { id: string };
    const body = voidBodySchema.parse(req.body);
    const invoice = await voidInvoice(id, body.reason, req.user.sub);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'VOID_INVOICE',
      targetType: 'SYSTEM',
      targetId: id,
      targetLabel: `发票 ${invoice.invoiceNo ?? id}`,
      after: {
        reason: invoice.voidReason,
        amountCny: invoice.amountCny,
        orders: invoice.orders.map((o) => o.orderNumber),
      },
    });
    return { invoice };
  });
};
