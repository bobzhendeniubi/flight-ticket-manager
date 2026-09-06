/**
 * 发票 —— 给客户 / 代理开的**真发票**（增值税专票 / 普票 / 收据）。
 *
 * ⚠️ 读到这里先分清两件事：
 *   · 订单上的 outboundInvoiced / returnInvoiced / systemInvoiced 三个布尔位，是票务岗的
 *     **出票**进度（去程出票没有、回程出票没有、系统里出票没有）。同事口中的「开票」指的
 *     就是它们，口径一个字不能动。
 *   · 本模块是财务的**发票**：抬头、税号、发票号、开具日、金额。
 *   两件事只是中文撞了名字。本模块**从不读、也从不写**那三个布尔位与旧的 Order.invoiceStatus，
 *   反过来也一样。任何一侧联动另一侧都是 bug。
 *
 * 状态机（三态，终局唯一）：
 *   REQUESTED —财务开具→ ISSUED
 *   REQUESTED / ISSUED —作废→ VOID（终局，必须填原因）
 * 作废之后那几张订单可以重新申请；未作废前同一张订单不许挂第二张有效发票。
 *
 * 金额一律服务端按关联订单的应收（total + adjustmentCny）合计算，**不收客户端传的数** ——
 * 发票金额不能由申请方说了算。建单时逐单快照，之后订单再改价也不追溯已申请的票。
 */
import {
  InvoiceRecordStatus,
  InvoiceType,
  Prisma,
  UserRole,
  type PrismaClient,
} from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { businessDateISO } from '../../lib/business-time.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';

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

/** 还「占着」订单的发票状态 —— 处于这两态时，同一张订单不许再申请第二张。 */
export const ACTIVE_INVOICE_STATUSES: InvoiceRecordStatus[] = [
  InvoiceRecordStatus.REQUESTED,
  InvoiceRecordStatus.ISSUED,
];

/** 一张发票最多能带几张订单。攒单开票是常态，但攒到没边就该拆开开。 */
const MAX_ORDERS_PER_INVOICE = 50;

function dec(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtDateOnly(d: Date | null | undefined): string | null {
  return d == null ? null : d.toISOString().slice(0, 10);
}

// ── 纯函数区（状态机 / 校验，可单测）─────────────────────────────────────────

/** 能不能开具。只有「待开具」能开——已开的再开会多出一个票号，已作废的不该复活。 */
export function canIssue(status: InvoiceRecordStatus): boolean {
  return status === InvoiceRecordStatus.REQUESTED;
}

/** 能不能作废。待开具与已开具都能作废；已作废是终局，再作废没有意义。 */
export function canVoid(status: InvoiceRecordStatus): boolean {
  return status === InvoiceRecordStatus.REQUESTED || status === InvoiceRecordStatus.ISSUED;
}

/** 专票必须有税号 —— 把它挡在申请那一步，别等财务开到一半才发现开不出来。 */
export function assertTaxNoForType(type: InvoiceType, taxNo: string | null | undefined): void {
  if (type === InvoiceType.VAT_SPECIAL && !taxNo?.trim()) {
    throw new BadRequestError('增值税专用发票必须填纳税人识别号');
  }
}

// ── RBAC ─────────────────────────────────────────────────────────────────────

export interface InvoiceRequester {
  userId: string;
  role: UserRole;
  /** role=AGENT 时解析出的自家 agentId */
  agentId?: string;
}

export function isFinanceSide(role: UserRole): boolean {
  return role === UserRole.ADMIN || role === UserRole.STAFF;
}

/**
 * 列表可见范围。
 *   ADMIN / STAFF  全部
 *   AGENT          只看自己名下（**不含下级**：发票抬头和税号是各家自己的事，
 *                  上级代理没有理由看到下级客户的抬头与税号）
 *   CUSTOMER       只看自己申请的
 */
export function invoiceScopeWhere(requester: InvoiceRequester): Prisma.InvoiceWhereInput {
  if (isFinanceSide(requester.role)) return {};
  if (requester.role === UserRole.AGENT) {
    // 没解析出 agentId 的代理账号（数据异常）一律看不到任何东西，绝不 fail-open 成「全部」
    return { agentId: requester.agentId ?? '__no_agent__' };
  }
  return { requestedByUserId: requester.userId };
}

// ── DTO ──────────────────────────────────────────────────────────────────────

export interface InvoiceOrderDto {
  orderId: string;
  orderNumber: string;
  amountCny: number;
}

export interface InvoiceDto {
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
  orders: InvoiceOrderDto[];
}

const INVOICE_INCLUDE = {
  agent: { select: { id: true, companyName: true, contactName: true } },
  orders: {
    include: { order: { select: { id: true, orderNumber: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.InvoiceInclude;

type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof INVOICE_INCLUDE }>;

export function toInvoiceDto(row: InvoiceRow): InvoiceDto {
  return {
    id: row.id,
    title: row.title,
    taxNo: row.taxNo,
    billingInfo: row.billingInfo,
    type: row.type,
    typeLabel: INVOICE_TYPE_LABEL[row.type],
    amountCny: round2(dec(row.amountCny)),
    status: row.status,
    statusLabel: INVOICE_STATUS_LABEL[row.status],
    invoiceNo: row.invoiceNo,
    issuedAt: fmtDateOnly(row.issuedAt),
    attachmentUrl: row.attachmentUrl,
    requestNote: row.requestNote,
    voidReason: row.voidReason,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    agentId: row.agentId,
    agentLabel: row.agent ? (row.agent.companyName ?? row.agent.contactName) : null,
    requestedByUserId: row.requestedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    orders: row.orders.map((link) => ({
      orderId: link.orderId,
      orderNumber: link.order.orderNumber,
      amountCny: round2(dec(link.amountCny)),
    })),
  };
}

// ── 查询 ─────────────────────────────────────────────────────────────────────

export interface ListInvoicesFilter {
  status?: InvoiceRecordStatus;
  type?: InvoiceType;
  /** 按订单号搜（回答「这张单开票了没」） */
  orderNumber?: string;
  limit?: number;
}

export async function listInvoices(
  requester: InvoiceRequester,
  filter: ListInvoicesFilter = {},
  client: PrismaClient = defaultPrisma,
): Promise<InvoiceDto[]> {
  const rows = await client.invoice.findMany({
    where: {
      ...invoiceScopeWhere(requester),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.orderNumber
        ? { orders: { some: { order: { orderNumber: { contains: filter.orderNumber } } } } }
        : {}),
    },
    include: INVOICE_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: filter.limit ?? 200,
  });
  return rows.map(toInvoiceDto);
}

export async function getInvoice(
  id: string,
  requester: InvoiceRequester,
  client: PrismaClient = defaultPrisma,
): Promise<InvoiceDto> {
  const row = await client.invoice.findFirst({
    where: { id, ...invoiceScopeWhere(requester) },
    include: INVOICE_INCLUDE,
  });
  // 找不到与看不到给同一个 404：不泄露「这张发票存在，只是不是你的」
  if (!row) throw new NotFoundError('发票不存在');
  return toInvoiceDto(row);
}

// ── 申请 ─────────────────────────────────────────────────────────────────────

export interface RequestInvoiceInput {
  orderIds: string[];
  title: string;
  taxNo?: string | null;
  billingInfo?: string | null;
  type: InvoiceType;
  requestNote?: string | null;
}

/**
 * 校验申请方能不能给这批订单开票 —— 「自家单」的判定就在这里，是本模块唯一的归属闸。
 *   AGENT       订单的 agentId 必须等于自己的 agentId（**不含下级**）
 *   CUSTOMER    订单的 userId 必须是自己
 *   ADMIN/STAFF 任意
 * 有一张不合规就整批拒 —— 不做「挑出能开的那几张」，那样申请人根本不知道少开了什么。
 */
export function assertOrdersOwned(
  orders: Array<{ id: string; orderNumber: string; agentId: string | null; userId: string | null }>,
  requester: InvoiceRequester,
): void {
  if (isFinanceSide(requester.role)) return;

  const bad = orders.filter((o) => {
    if (requester.role === UserRole.AGENT) {
      return !requester.agentId || o.agentId !== requester.agentId;
    }
    return o.userId !== requester.userId;
  });
  if (bad.length > 0) {
    throw new ForbiddenError(
      `只能给自家订单申请发票（不属于你的：${bad.map((o) => o.orderNumber).join('、')}）`,
    );
  }
}

/** 订单的开票金额口径 = 应收 = total + adjustmentCny（与「尾款」同一套应付口径）。 */
export function orderInvoiceableCny(order: {
  total: Prisma.Decimal | number;
  adjustmentCny: number;
}): number {
  return round2(dec(order.total) + order.adjustmentCny);
}

export async function requestInvoice(
  input: RequestInvoiceInput,
  requester: InvoiceRequester,
  client: PrismaClient = defaultPrisma,
): Promise<InvoiceDto> {
  const title = input.title.trim();
  if (!title) throw new BadRequestError('发票抬头不能为空');
  assertTaxNoForType(input.type, input.taxNo);

  const orderIds = Array.from(new Set(input.orderIds));
  if (orderIds.length === 0) throw new BadRequestError('至少要选一张订单');
  if (orderIds.length > MAX_ORDERS_PER_INVOICE) {
    throw new BadRequestError(`一张发票最多带 ${MAX_ORDERS_PER_INVOICE} 张订单，请分开申请`);
  }

  const invoiceId = await client.$transaction(async (tx) => {
    const orders = await tx.order.findMany({
      where: { id: { in: orderIds }, deletedAt: null },
      select: {
        id: true,
        orderNumber: true,
        agentId: true,
        userId: true,
        total: true,
        adjustmentCny: true,
      },
    });
    if (orders.length !== orderIds.length) {
      throw new NotFoundError('有订单不存在或已删除');
    }
    assertOrdersOwned(orders, requester);

    // 防重复开票：这几张单上还挂着没作废的发票就整批拒，并把是哪几张告诉申请人。
    // 闸只能在事务里判——状态长在 Invoice 上，DB 唯一索引跨不了表。
    const clash = await tx.invoiceOrder.findMany({
      where: {
        orderId: { in: orderIds },
        invoice: { status: { in: ACTIVE_INVOICE_STATUSES } },
      },
      select: { orderId: true },
    });
    if (clash.length > 0) {
      const numbers = clash
        .map((c) => orders.find((o) => o.id === c.orderId)?.orderNumber ?? c.orderId)
        .join('、');
      throw new ConflictError(
        `这些订单已经有未作废的发票，不能重复申请：${numbers}。如需重开，请先作废原发票。`,
      );
    }

    const links = orders.map((o) => ({
      orderId: o.id,
      amountCny: new Prisma.Decimal(orderInvoiceableCny(o)),
    }));
    const amountCny = round2(links.reduce((sum, l) => sum + dec(l.amountCny), 0));
    if (amountCny <= 0) {
      throw new BadRequestError('这批订单的应收合计为 0，没有可开票金额');
    }

    const created = await tx.invoice.create({
      data: {
        title,
        taxNo: input.taxNo?.trim() || null,
        billingInfo: input.billingInfo?.trim() || null,
        type: input.type,
        amountCny: new Prisma.Decimal(amountCny),
        status: InvoiceRecordStatus.REQUESTED,
        requestedByUserId: requester.userId,
        // 代理申请就记归属代理；财务代客户申请时不记（那张票不算在任何代理名下）
        agentId: requester.role === UserRole.AGENT ? (requester.agentId ?? null) : null,
        requestNote: input.requestNote?.trim() || null,
        orders: { create: links },
      },
      select: { id: true },
    });
    return created.id;
  });

  const row = await client.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: INVOICE_INCLUDE,
  });
  return toInvoiceDto(row);
}

// ── 开具 / 作废（财务）──────────────────────────────────────────────────────

export interface IssueInvoiceInput {
  invoiceNo: string;
  /** 开具日；缺省 = 今天（北京业务日，不是 UTC 日） */
  issuedAt?: string;
  attachmentUrl?: string | null;
}

export async function issueInvoice(
  id: string,
  input: IssueInvoiceInput,
  issuedBy: string | null,
  client: PrismaClient = defaultPrisma,
): Promise<InvoiceDto> {
  const invoiceNo = input.invoiceNo.trim();
  if (!invoiceNo) throw new BadRequestError('发票号不能为空');
  const issuedAtStr = input.issuedAt ?? businessDateISO(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(issuedAtStr)) {
    throw new BadRequestError('开具日格式应为 YYYY-MM-DD');
  }

  await client.$transaction(async (tx) => {
    const existing = await tx.invoice.findUnique({
      where: { id },
      select: { id: true, status: true, type: true, taxNo: true },
    });
    if (!existing) throw new NotFoundError('发票不存在');
    if (!canIssue(existing.status)) {
      throw new ConflictError(
        existing.status === InvoiceRecordStatus.ISSUED
          ? '这张发票已经开过了，重复开具会多出一个票号'
          : '已作废的发票不能再开具，请让客户重新申请',
      );
    }
    // 专票税号在申请那步已闸过一次；开具前再确认一次（申请后抬头被改过的情况）
    assertTaxNoForType(existing.type, existing.taxNo);

    await tx.invoice.update({
      where: { id },
      data: {
        status: InvoiceRecordStatus.ISSUED,
        invoiceNo,
        issuedAt: new Date(`${issuedAtStr}T00:00:00.000Z`),
        attachmentUrl: input.attachmentUrl?.trim() || null,
        issuedBy,
      },
    });
  });

  const row = await client.invoice.findUniqueOrThrow({ where: { id }, include: INVOICE_INCLUDE });
  return toInvoiceDto(row);
}

export async function voidInvoice(
  id: string,
  reason: string,
  voidedBy: string | null,
  client: PrismaClient = defaultPrisma,
): Promise<InvoiceDto> {
  const trimmed = reason.trim();
  // 作废必须留原因：一张开出去的票被作废，事后一定有人要问「为什么」
  if (!trimmed) throw new BadRequestError('作废发票必须填原因');

  await client.$transaction(async (tx) => {
    const existing = await tx.invoice.findUnique({ where: { id }, select: { status: true } });
    if (!existing) throw new NotFoundError('发票不存在');
    if (!canVoid(existing.status)) throw new ConflictError('这张发票已经作废了');
    await tx.invoice.update({
      where: { id },
      data: {
        status: InvoiceRecordStatus.VOID,
        voidReason: trimmed,
        voidedAt: new Date(),
        voidedBy,
      },
    });
  });

  const row = await client.invoice.findUniqueOrThrow({ where: { id }, include: INVOICE_INCLUDE });
  return toInvoiceDto(row);
}
