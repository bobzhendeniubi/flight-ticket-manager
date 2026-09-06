/**
 * 供应商应付账单 + 付款核销
 *
 * 补的是「钱付出去」那一侧唯一没有系统痕迹的一段。收进来的钱有 Payment/Receipt 两本账，
 * 付出去的钱——航司包机款、酒店净房账单、签证公司美金账单——全在 Excel 和微信里。
 *
 * 本模块只做记账与核销，一步都不越界：
 *   · **不改任何成本计算口径**。毛利照旧由 FlightCostPeriod / 房型净房价 / 签证任务成本算，
 *     账单金额与它们各算各的；对账视图把两边并排放，差多少由人看，系统不替谁改数。
 *   · 不动订单、不动收款、不动佣金。这里的钱只出不进，和客户侧那本账没有任何交叉。
 *
 * ── 币种口径（与包机成本汇率四元组同一套做法）──
 *   amount    = 供应商账单上印的那个数，原币
 *   fxRate    = 原币→CNY；CNY 账单留空
 *   amountCny = 折算后人民币，入账权威。折完固化，之后改汇率表绝不追溯已录的账单。
 * 付款每笔自带汇率：同一张美金账单分两次付，两天汇率不同，CNY 实付自然不同。
 *
 * ── 核销口径 ──
 * 核销按**原币**比：欠 1000 美金就要付够 1000 美金，中间汇率怎么动都不改变「这张付清没有」。
 * CNY 侧只是实付折人民币的记录（拿去做现金流，不做清偿判断）。
 */
import {
  Prisma,
  SupplierInvoicePeriodKind,
  SupplierInvoiceStatus,
  type PrismaClient,
} from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { localDateISO } from '../../lib/flight-time.js';
import { SUPPLIER_TYPE_LABEL, normalizeCurrency } from './suppliers.service.js';

/** 付款渠道白名单。用字符串常量而非 Prisma enum：渠道会随收付款方式变，加一个不该要一次迁移。 */
export const SUPPLIER_PAY_METHODS = ['BANK', 'WECHAT', 'ALIPAY', 'CASH', 'OTHER'] as const;
export type SupplierPayMethod = (typeof SUPPLIER_PAY_METHODS)[number];

export const SUPPLIER_PAY_METHOD_LABEL: Record<SupplierPayMethod, string> = {
  BANK: '银行转账',
  WECHAT: '微信',
  ALIPAY: '支付宝',
  CASH: '现金',
  OTHER: '其他',
};

export const SUPPLIER_INVOICE_STATUS_LABEL: Record<SupplierInvoiceStatus, string> = {
  DRAFT: '草稿',
  CONFIRMED: '已确认',
  PARTIALLY_PAID: '部分付款',
  PAID: '已付清',
  DISPUTED: '有争议',
};

export const SUPPLIER_INVOICE_PERIOD_LABEL: Record<SupplierInvoicePeriodKind, string> = {
  FLIGHT_SCHEDULE: '按航班班次',
  MONTH: '按月',
  CUSTOM: '自定义区间',
};

/**
 * 金额比较容差。两边都是 DECIMAL(14,2)，比大小时留半分的余量，
 * 免得「刚好付清」因为浮点尾巴被判成没付清。
 */
const AMOUNT_EPSILON = 0.005;

// ── 纯函数区（可单测，不碰 DB）────────────────────────────────────────────────

function dec(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}

function decOrNull(v: Prisma.Decimal | number | null | undefined): number | null {
  return v == null ? null : dec(v);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 账单状态推导 —— 核销的全部规则就这一个函数。
 *
 * DRAFT / DISPUTED 是**人工态**：账还没认，或认了但金额有争议。两者都不许登记付款，
 * 状态也绝不因为付款而自动跳走（否则「挂起不付」的争议单会被一笔误录的付款悄悄转成已付）。
 *
 * CONFIRMED / PARTIALLY_PAID / PAID 是**派生态**：认账之后由 Σ 付款说了算，人手改不动。
 * 撤销一笔错录的付款会让状态自动退回去，这正是要的——账不能只进不退。
 */
export function deriveInvoiceStatus(
  current: SupplierInvoiceStatus,
  paidAmount: number,
  invoiceAmount: number,
): SupplierInvoiceStatus {
  if (current === SupplierInvoiceStatus.DRAFT || current === SupplierInvoiceStatus.DISPUTED) {
    return current;
  }
  if (paidAmount <= AMOUNT_EPSILON) return SupplierInvoiceStatus.CONFIRMED;
  if (paidAmount + AMOUNT_EPSILON >= invoiceAmount) return SupplierInvoiceStatus.PAID;
  return SupplierInvoiceStatus.PARTIALLY_PAID;
}

/** 能不能往这张账单上登记付款。草稿=还没认账，争议=挂起不付，两者都 fail-closed 拒。 */
export function canRegisterPayment(status: SupplierInvoiceStatus): boolean {
  return (
    status === SupplierInvoiceStatus.CONFIRMED ||
    status === SupplierInvoiceStatus.PARTIALLY_PAID ||
    status === SupplierInvoiceStatus.PAID
  );
}

/**
 * 原币 → CNY 折算。CNY 账单不许填汇率（填了就是口径混乱）；外币账单必须填。
 * 折算结果当场固化，之后谁改汇率表都不追溯。
 */
export function convertToCny(
  amount: number,
  currency: string,
  fxRate: number | null | undefined,
): number {
  if (currency === 'CNY') {
    if (fxRate != null && Math.abs(fxRate - 1) > 1e-9) {
      throw new BadRequestError('人民币账单不需要填汇率');
    }
    return round2(amount);
  }
  if (fxRate == null) throw new BadRequestError(`${currency} 账单必须填汇率（原币→人民币）`);
  if (!(fxRate > 0)) throw new BadRequestError('汇率必须大于 0');
  return round2(amount * fxRate);
}

/** 'YYYY-MM-DD' → date-only UTC 午夜。@db.Date 列不折时区，直接按字面日期存。 */
export function toDateOnly(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(s)) throw new BadRequestError(`日期格式应为 YYYY-MM-DD：${s}`);
  return new Date(`${s}T00:00:00.000Z`);
}

export function fmtDateOnly(d: Date | null | undefined): string | null {
  return d == null ? null : d.toISOString().slice(0, 10);
}

/** 'YYYY-MM' → 该月的闭区间 [首日, 末日]。 */
export function monthToRange(month: string): { from: Date; to: Date } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month)) {
    throw new BadRequestError(`月份格式应为 YYYY-MM：${month}`);
  }
  const [y, m] = month.split('-').map((x) => parseInt(x, 10));
  const from = new Date(Date.UTC(y, m - 1, 1));
  // 下个月 0 号 = 本月末日
  const to = new Date(Date.UTC(y, m, 0));
  return { from, to };
}

// ── DTO ──────────────────────────────────────────────────────────────────────

export interface SupplierPaymentDto {
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

export interface SupplierInvoiceLineDto {
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

export interface SupplierInvoiceDto {
  id: string;
  supplierId: string;
  supplierName: string;
  supplierTypeLabel: string;
  invoiceNo: string | null;
  periodKind: SupplierInvoicePeriodKind;
  periodKindLabel: string;
  /** 人话期次（「QH0000 · 2026-09-01」/「2026-09」/「2026-09-01 ~ 2026-09-15」） */
  periodLabel: string;
  flightScheduleId: string | null;
  periodMonth: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  currency: string;
  amount: number;
  fxRate: number | null;
  amountCny: number;
  /** Σ 付款（原币）—— 核销就是拿它和 amount 比 */
  paidAmount: number;
  /** Σ 付款折人民币实付（现金流口径，不参与清偿判断） */
  paidAmountCny: number;
  /** 未付（原币）= amount − paidAmount，最小 0 */
  outstandingAmount: number;
  status: SupplierInvoiceStatus;
  statusLabel: string;
  attachmentUrl: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  payments: SupplierPaymentDto[];
  lines: SupplierInvoiceLineDto[];
}

const INVOICE_INCLUDE = {
  supplier: { select: { id: true, name: true, type: true } },
  flightSchedule: {
    select: {
      id: true,
      departureTime: true,
      departureTz: true,
      flight: { select: { flightNumber: true } },
    },
  },
  payments: { orderBy: { paidOn: 'asc' as const } },
  lines: { orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.SupplierInvoiceInclude;

type InvoiceRow = Prisma.SupplierInvoiceGetPayload<{ include: typeof INVOICE_INCLUDE }>;

function periodLabelOf(row: InvoiceRow): string {
  if (row.periodKind === SupplierInvoicePeriodKind.FLIGHT_SCHEDULE) {
    if (!row.flightSchedule) return '（班次已删除）';
    // 期次日期在建单时已按班次出发日固化进 periodFrom（date-only，不折时区），
    // 这里直接取它，不在展示层重新推导时刻。
    const dateStr = fmtDateOnly(row.periodFrom) ?? '';
    return `${row.flightSchedule.flight.flightNumber} · ${dateStr}`;
  }
  if (row.periodKind === SupplierInvoicePeriodKind.MONTH) return row.periodMonth ?? '—';
  const from = fmtDateOnly(row.periodFrom);
  const to = fmtDateOnly(row.periodTo);
  return from && to ? `${from} ~ ${to}` : '—';
}

export function toInvoiceDto(row: InvoiceRow): SupplierInvoiceDto {
  const amount = dec(row.amount);
  const paidAmount = round2(row.payments.reduce((sum, p) => sum + dec(p.amount), 0));
  const paidAmountCny = round2(row.payments.reduce((sum, p) => sum + dec(p.amountCny), 0));
  return {
    id: row.id,
    supplierId: row.supplierId,
    supplierName: row.supplier.name,
    supplierTypeLabel: SUPPLIER_TYPE_LABEL[row.supplier.type],
    invoiceNo: row.invoiceNo,
    periodKind: row.periodKind,
    periodKindLabel: SUPPLIER_INVOICE_PERIOD_LABEL[row.periodKind],
    periodLabel: periodLabelOf(row),
    flightScheduleId: row.flightScheduleId,
    periodMonth: row.periodMonth,
    periodFrom: fmtDateOnly(row.periodFrom),
    periodTo: fmtDateOnly(row.periodTo),
    currency: row.currency,
    amount: round2(amount),
    fxRate: decOrNull(row.fxRate),
    amountCny: round2(dec(row.amountCny)),
    paidAmount,
    paidAmountCny,
    outstandingAmount: round2(Math.max(0, amount - paidAmount)),
    status: row.status,
    statusLabel: SUPPLIER_INVOICE_STATUS_LABEL[row.status],
    attachmentUrl: row.attachmentUrl,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    payments: row.payments.map((p) => ({
      id: p.id,
      paidOn: fmtDateOnly(p.paidOn) ?? '',
      amount: round2(dec(p.amount)),
      fxRate: decOrNull(p.fxRate),
      amountCny: round2(dec(p.amountCny)),
      method: p.method,
      methodLabel: SUPPLIER_PAY_METHOD_LABEL[p.method as SupplierPayMethod] ?? p.method,
      reference: p.reference,
      payerLabel: p.payerLabel,
      note: p.note,
      createdAt: p.createdAt.toISOString(),
    })),
    lines: row.lines.map((l) => ({
      id: l.id,
      label: l.label,
      quantity: decOrNull(l.quantity),
      amount: round2(dec(l.amount)),
      amountCny: round2(dec(l.amountCny)),
      flightScheduleId: l.flightScheduleId,
      hotelBlockPeriodId: l.hotelBlockPeriodId,
      orderId: l.orderId,
      note: l.note,
    })),
  };
}

// ── 期次归一 ─────────────────────────────────────────────────────────────────
// 三种期次都派生出 periodFrom/periodTo，好让「这段时间我欠了谁多少」用一个区间查询答完。

export interface PeriodInput {
  periodKind: SupplierInvoicePeriodKind;
  flightScheduleId?: string | null;
  periodMonth?: string | null;
  periodFrom?: string | null;
  periodTo?: string | null;
}

export interface ResolvedPeriod {
  flightScheduleId: string | null;
  periodMonth: string | null;
  periodFrom: Date | null;
  periodTo: Date | null;
}

/**
 * 把三种期次归一成 { 班次, 月份, 起, 止 }。
 * FLIGHT_SCHEDULE 的起止由班次出发日填（同一天），要读 DB 拿班次。
 */
export async function resolvePeriod(
  input: PeriodInput,
  client: PrismaClient,
): Promise<ResolvedPeriod> {
  if (input.periodKind === SupplierInvoicePeriodKind.FLIGHT_SCHEDULE) {
    if (!input.flightScheduleId) throw new BadRequestError('按航班班次开的账单必须选班次');
    const sched = await client.flightSchedule.findUnique({
      where: { id: input.flightScheduleId },
      select: { id: true, departureTime: true, departureTz: true },
    });
    if (!sched) throw new NotFoundError('航班班次不存在');
    // 班次日按出发地时区取（与全站航班时刻口径一致：班次存 UTC，展示/归期按 departureTz 折）
    const day = toDateOnly(localDateISO(sched.departureTime, sched.departureTz));
    return { flightScheduleId: sched.id, periodMonth: null, periodFrom: day, periodTo: day };
  }

  if (input.periodKind === SupplierInvoicePeriodKind.MONTH) {
    if (!input.periodMonth) throw new BadRequestError('按月开的账单必须填月份（YYYY-MM）');
    const { from, to } = monthToRange(input.periodMonth);
    return {
      flightScheduleId: null,
      periodMonth: input.periodMonth,
      periodFrom: from,
      periodTo: to,
    };
  }

  if (!input.periodFrom || !input.periodTo) {
    throw new BadRequestError('自定义区间账单必须填起止日期');
  }
  const from = toDateOnly(input.periodFrom);
  const to = toDateOnly(input.periodTo);
  if (from > to) throw new BadRequestError('区间起始日不能晚于截止日');
  return { flightScheduleId: null, periodMonth: null, periodFrom: from, periodTo: to };
}

// ── 查询 ─────────────────────────────────────────────────────────────────────

export interface ListInvoicesFilter {
  supplierId?: string;
  status?: SupplierInvoiceStatus;
  /** 期次与 [from,to] 有交叠即命中 */
  from?: string;
  to?: string;
  limit?: number;
}

export interface ListInvoicesResult {
  rows: SupplierInvoiceDto[];
  /** 未付合计（折人民币）—— 「现在一共欠出去多少」，卡片用 */
  outstandingCny: number;
  /** 账单总额合计（折人民币） */
  totalCny: number;
  /** 已付合计（折人民币） */
  paidCny: number;
}

export async function listSupplierInvoices(
  filter: ListInvoicesFilter = {},
  client: PrismaClient = defaultPrisma,
): Promise<ListInvoicesResult> {
  const where: Prisma.SupplierInvoiceWhereInput = {
    ...(filter.supplierId ? { supplierId: filter.supplierId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    // 区间交叠：periodFrom ≤ to 且 periodTo ≥ from
    ...(filter.to ? { periodFrom: { lte: toDateOnly(filter.to) } } : {}),
    ...(filter.from ? { periodTo: { gte: toDateOnly(filter.from) } } : {}),
  };
  const rows = await client.supplierInvoice.findMany({
    where,
    include: INVOICE_INCLUDE,
    orderBy: [{ periodFrom: 'desc' }, { createdAt: 'desc' }],
    take: filter.limit ?? 200,
  });
  const dtos = rows.map(toInvoiceDto);

  // 汇总一律用 CNY 侧：几家供应商币种不同，原币加总没有意义。
  let totalCny = 0;
  let paidCny = 0;
  let outstandingCny = 0;
  for (const d of dtos) {
    totalCny += d.amountCny;
    paidCny += d.paidAmountCny;
    // 未付折人民币按**账单**汇率折（付款侧汇率只对已付部分成立）
    const rate = d.currency === 'CNY' ? 1 : (d.fxRate ?? 0);
    outstandingCny += d.outstandingAmount * rate;
  }
  return {
    rows: dtos,
    totalCny: round2(totalCny),
    paidCny: round2(paidCny),
    outstandingCny: round2(outstandingCny),
  };
}

export async function getSupplierInvoice(
  id: string,
  client: PrismaClient = defaultPrisma,
): Promise<SupplierInvoiceDto> {
  const row = await client.supplierInvoice.findUnique({ where: { id }, include: INVOICE_INCLUDE });
  if (!row) throw new NotFoundError('应付账单不存在');
  return toInvoiceDto(row);
}

// ── 写入 ─────────────────────────────────────────────────────────────────────

export interface InvoiceLineInput {
  label: string;
  quantity?: number | null;
  amount: number;
  flightScheduleId?: string | null;
  hotelBlockPeriodId?: string | null;
  orderId?: string | null;
  note?: string | null;
}

export interface CreateInvoiceInput extends PeriodInput {
  supplierId: string;
  invoiceNo?: string | null;
  currency?: string;
  amount: number;
  fxRate?: number | null;
  status?: SupplierInvoiceStatus;
  attachmentUrl?: string | null;
  note?: string | null;
  lines?: InvoiceLineInput[];
}

export async function createSupplierInvoice(
  input: CreateInvoiceInput,
  createdBy: string | null,
  client: PrismaClient = defaultPrisma,
): Promise<SupplierInvoiceDto> {
  const supplier = await client.supplier.findUnique({
    where: { id: input.supplierId },
    select: { id: true, currency: true, isActive: true },
  });
  if (!supplier) throw new NotFoundError('供应商不存在');
  if (!supplier.isActive) throw new BadRequestError('该供应商已停用，不能开新账单');

  const currency = normalizeCurrency(input.currency ?? supplier.currency);
  if (!(input.amount > 0)) throw new BadRequestError('账单金额必须大于 0');
  const amountCny = convertToCny(input.amount, currency, input.fxRate);
  const period = await resolvePeriod(input, client);

  const row = await client.supplierInvoice.create({
    data: {
      supplierId: input.supplierId,
      invoiceNo: input.invoiceNo?.trim() || null,
      periodKind: input.periodKind,
      flightScheduleId: period.flightScheduleId,
      periodMonth: period.periodMonth,
      periodFrom: period.periodFrom,
      periodTo: period.periodTo,
      currency,
      amount: new Prisma.Decimal(round2(input.amount)),
      fxRate: input.fxRate == null ? null : new Prisma.Decimal(input.fxRate),
      amountCny: new Prisma.Decimal(amountCny),
      // 新账单默认草稿：先录进来，跟供应商对上了再确认。确认之后才谈付款。
      status: input.status ?? SupplierInvoiceStatus.DRAFT,
      attachmentUrl: input.attachmentUrl?.trim() || null,
      note: input.note?.trim() || null,
      createdBy,
      lines: {
        create: (input.lines ?? []).map((l) => ({
          label: l.label.trim(),
          quantity: l.quantity == null ? null : new Prisma.Decimal(l.quantity),
          amount: new Prisma.Decimal(round2(l.amount)),
          amountCny: new Prisma.Decimal(convertToCny(l.amount, currency, input.fxRate)),
          flightScheduleId: l.flightScheduleId ?? null,
          hotelBlockPeriodId: l.hotelBlockPeriodId ?? null,
          orderId: l.orderId ?? null,
          note: l.note?.trim() || null,
        })),
      },
    },
    include: INVOICE_INCLUDE,
  });
  return toInvoiceDto(row);
}

export interface UpdateInvoiceInput {
  invoiceNo?: string | null;
  currency?: string;
  amount?: number;
  fxRate?: number | null;
  status?: SupplierInvoiceStatus;
  attachmentUrl?: string | null;
  note?: string | null;
}

/**
 * 改账单头。三道闸：
 *   · 金额不许改到低于已付 —— 那等于凭空造出一笔「多付」，账立刻不平；
 *   · 状态只能改到人工态（DRAFT/CONFIRMED/DISPUTED）；派生态由付款说了算，
 *     手动指定 PAID/PARTIALLY_PAID 一律拒绝（否则一张没付钱的账单能被点成已付清）；
 *   · 已登记过付款的账单退不回草稿（草稿态不许挂付款，退回去等于让付款记录悬空）。
 */
export async function updateSupplierInvoice(
  id: string,
  patch: UpdateInvoiceInput,
  client: PrismaClient = defaultPrisma,
): Promise<SupplierInvoiceDto> {
  const existing = await client.supplierInvoice.findUnique({
    where: { id },
    include: { payments: { select: { amount: true } } },
  });
  if (!existing) throw new NotFoundError('应付账单不存在');

  const paidAmount = round2(existing.payments.reduce((s, p) => s + dec(p.amount), 0));

  if (patch.status !== undefined) {
    const manual: SupplierInvoiceStatus[] = [
      SupplierInvoiceStatus.DRAFT,
      SupplierInvoiceStatus.CONFIRMED,
      SupplierInvoiceStatus.DISPUTED,
    ];
    if (!manual.includes(patch.status)) {
      throw new BadRequestError('「部分付款 / 已付清」由付款记录自动推导，不能手工指定');
    }
    if (patch.status === SupplierInvoiceStatus.DRAFT && paidAmount > AMOUNT_EPSILON) {
      throw new BadRequestError('已登记付款的账单不能退回草稿，请先撤销付款记录');
    }
  }

  const currency =
    patch.currency === undefined ? existing.currency : normalizeCurrency(patch.currency);
  const amount = patch.amount === undefined ? dec(existing.amount) : round2(patch.amount);
  if (!(amount > 0)) throw new BadRequestError('账单金额必须大于 0');
  if (amount + AMOUNT_EPSILON < paidAmount) {
    throw new BadRequestError(
      `账单金额不能低于已付金额（已付 ${paidAmount.toFixed(2)} ${currency}）`,
    );
  }
  const fxRate = patch.fxRate === undefined ? decOrNull(existing.fxRate) : patch.fxRate;
  const amountCny = convertToCny(amount, currency, fxRate);

  // 改完金额，派生态要跟着重算（比如金额调低到正好等于已付 → 直接付清）
  const nextStatus = deriveInvoiceStatus(patch.status ?? existing.status, paidAmount, amount);

  const row = await client.supplierInvoice.update({
    where: { id },
    data: {
      ...(patch.invoiceNo === undefined ? {} : { invoiceNo: patch.invoiceNo?.trim() || null }),
      currency,
      amount: new Prisma.Decimal(amount),
      fxRate: fxRate == null ? null : new Prisma.Decimal(fxRate),
      amountCny: new Prisma.Decimal(amountCny),
      status: nextStatus,
      ...(patch.attachmentUrl === undefined
        ? {}
        : { attachmentUrl: patch.attachmentUrl?.trim() || null }),
      ...(patch.note === undefined ? {} : { note: patch.note?.trim() || null }),
    },
    include: INVOICE_INCLUDE,
  });
  return toInvoiceDto(row);
}

// ── 付款登记 / 撤销 ──────────────────────────────────────────────────────────

export interface AddPaymentInput {
  paidOn: string;
  amount: number;
  fxRate?: number | null;
  method: SupplierPayMethod;
  reference?: string | null;
  payerLabel?: string | null;
  note?: string | null;
}

/**
 * 登记一笔付款并重算核销状态。整段在事务里：Σ 付款是判超付的依据，
 * 读完就写、中间不能被另一笔付款插进来（两个人同时点「登记付款」是真实场景）。
 *
 * 超付直接拒：付多了不是四舍五入的小事，是要么金额录错、要么这笔钱压根不属于这张账单。
 */
export async function addSupplierPayment(
  invoiceId: string,
  input: AddPaymentInput,
  createdBy: string | null,
  client: PrismaClient = defaultPrisma,
): Promise<SupplierInvoiceDto> {
  if (!(input.amount > 0)) throw new BadRequestError('付款金额必须大于 0');
  if (!SUPPLIER_PAY_METHODS.includes(input.method)) {
    throw new BadRequestError('付款渠道不在允许范围内');
  }
  const paidOn = toDateOnly(input.paidOn);

  await client.$transaction(async (tx) => {
    const invoice = await tx.supplierInvoice.findUnique({
      where: { id: invoiceId },
      include: { payments: { select: { amount: true } } },
    });
    if (!invoice) throw new NotFoundError('应付账单不存在');
    if (!canRegisterPayment(invoice.status)) {
      throw new ConflictError(
        invoice.status === SupplierInvoiceStatus.DRAFT
          ? '草稿账单不能登记付款，请先与供应商核对并确认账单'
          : '有争议的账单已挂起，不能登记付款；请先消除争议把账单改回已确认',
      );
    }

    const invoiceAmount = dec(invoice.amount);
    const paidBefore = round2(invoice.payments.reduce((s, p) => s + dec(p.amount), 0));
    const paidAfter = round2(paidBefore + input.amount);
    if (paidAfter > invoiceAmount + AMOUNT_EPSILON) {
      throw new ConflictError(
        `付款合计会超过账单金额：已付 ${paidBefore.toFixed(2)} + 本次 ${input.amount.toFixed(2)} ` +
          `> 账单 ${invoiceAmount.toFixed(2)} ${invoice.currency}`,
      );
    }

    const amountCny = convertToCny(input.amount, invoice.currency, input.fxRate);
    await tx.supplierPayment.create({
      data: {
        invoiceId,
        paidOn,
        amount: new Prisma.Decimal(round2(input.amount)),
        fxRate: input.fxRate == null ? null : new Prisma.Decimal(input.fxRate),
        amountCny: new Prisma.Decimal(amountCny),
        method: input.method,
        reference: input.reference?.trim() || null,
        payerLabel: input.payerLabel?.trim() || null,
        note: input.note?.trim() || null,
        createdBy,
      },
    });
    await tx.supplierInvoice.update({
      where: { id: invoiceId },
      data: { status: deriveInvoiceStatus(invoice.status, paidAfter, invoiceAmount) },
    });
  });

  return getSupplierInvoice(invoiceId, client);
}

/**
 * 撤销一笔付款（录错了）。删记录 + 重算状态 —— 撤掉最后一笔会把 PAID 退回 PARTIALLY_PAID
 * 或 CONFIRMED，这正是要的：账要能退，否则一次手滑就永久假装付清了。
 */
export async function deleteSupplierPayment(
  invoiceId: string,
  paymentId: string,
  client: PrismaClient = defaultPrisma,
): Promise<SupplierInvoiceDto> {
  await client.$transaction(async (tx) => {
    const invoice = await tx.supplierInvoice.findUnique({
      where: { id: invoiceId },
      include: { payments: { select: { id: true, amount: true } } },
    });
    if (!invoice) throw new NotFoundError('应付账单不存在');
    if (!invoice.payments.some((p) => p.id === paymentId)) {
      throw new NotFoundError('付款记录不存在');
    }

    await tx.supplierPayment.delete({ where: { id: paymentId } });

    const paidAfter = round2(
      invoice.payments.filter((p) => p.id !== paymentId).reduce((s, p) => s + dec(p.amount), 0),
    );
    await tx.supplierInvoice.update({
      where: { id: invoiceId },
      data: { status: deriveInvoiceStatus(invoice.status, paidAfter, dec(invoice.amount)) },
    });
  });

  return getSupplierInvoice(invoiceId, client);
}
