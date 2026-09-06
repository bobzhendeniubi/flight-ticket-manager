// 由 orders.service.ts 机械拆出（审查根因 R5，2026-09-06）：只搬代码、不改口径。
// 对外契约仍从 ../orders.service.js 取（facade 原名再导出）；OrderService 方法体在这里是
// `export function xxx(svc: OrderService, ...)`，方法里的 `this.` 一律写成 `svc.`——
// 跨组调用仍走 facade 实例，单测里对 OrderService 实例的 spy 行为不变。

import {
  AuditSeverity,
  AuditTargetType,
  CabinClass,
  InvoiceStatus,
  OrderItemKind,
  OrderStatus,
  PassengerType,
  Prisma,
  type PrismaClient,
  type SettlementTier,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import {
  AppError,
  BadRequestError,
  ConflictError,
  DuplicatePassengerError,
  ForbiddenError,
  NotFoundError,
} from '../../../lib/errors.js';
import { splitPassengerFullName } from '../../../lib/passenger-name.js';
import { levenshteinDistance, TYPO_MAX_EDIT_DISTANCE } from '../../../lib/edit-distance.js';
import { orderVisaStatusRequiresVisa } from '../visa-need.js';
import { computePerPaxShares, spreadableAdjustmentCny } from '../per-pax-share.js';
import { groupPassengerAdjustments } from '../order-adjustment-lines.js';
import { localDate } from '../../finances/finances.cost.service.js';
import { getSettlementRate } from '../../settlement-rates/settlement-rates.service.js';
import { BUNDLE_ROUTE_SELECT, bundleRouteKey } from '../../products/bundle-route.js';
import { getFlightSettlementRate } from '../../settlement-rates/flight-settlement-rates.service.js';
import {
  resolveAgentSettlementDiscount,
} from '../../settlement-discounts/settlement-discounts.service.js';
import { derivePtcByAge, earliestFlightDeparture } from '../pnr-export.js';
import {
  assertNoVisaContradiction,
  orderVisaDeclarationEvent,
  rederiveVisaTaskStatus,
  resetVisaTaskProgress,
  transitionPassengerVisa,
  writeOrderVisaStatus,
  writePassengerVisaExempt,
} from '../../fulfillment/visa-state.js';
import { syncOrderVisaCompletion } from '../../fulfillment/visa-completion.js';
import {
  PER_PERSON_TRAVEL_KINDS,
  POST_SALE_FEE_CAP_CNY,
  PRICE_ADJUSTMENT_CAP_CNY,
  PRICE_ADJUSTMENT_REASON_LABEL,
} from '../orders.schemas.js';
import type {
  SelfUpdatePassengerBody,
  UpdatePassengerTicketBody,
  UpdatePassengerVisaDatesBody,
} from '../orders.schemas.js';
import {
  FulfillmentStatus,
  FulfillmentType,
  VisaRequirement,
  VisaSubmissionStatus,
} from '@prisma/client';
import {
  type BundleAddOnBreakdown,
  type BundleBusinessUpgradeSplit,
  computeBundleAddOn,
  derivePerPaxBundleOptions,
  resolveBundleOccupancy,
} from './bundle-pricing.js';
import { readJsonObject } from './leg-action-log.js';
import {
  deriveOrderDepartDate,
  orderSerializeRoleCtx,
  serializeOrder,
  serializePassengerRecord,
} from './read.js';
import {
  actorCan,
  AGENT_SELF_EDIT_REASON,
  appendAdjustment,
  type AutoDiscountSummary,
  buildPriceAdjustmentItem,
  computeAgentSelfEditWindow,
  type DuplicatePassengerConflict,
  FULFILLMENT_TERMINATING_STATUSES,
  keyChangedDetail,
  ORDER_FULL_INCLUDE,
  type OrderAdjustmentEntry,
  type OrderRequester,
  ptcToPassengerType,
  readCalendarKey,
  resolveCalendarPerPaxBasis,
  round2,
  SEAT_HOLDING_STATUSES,
  SELF_EDITABLE_PASSENGER_STATUSES,
  sumAccruedCommissionCny,
  type SwapCalendarKey,
  zhStatus,
} from './shared.js';
import { syncVisaTasksForOrder } from './visa-sync.js';
import type { OrderService } from '../orders.service.js';
import { runOrderMutation } from './order-mutation.js';
import { persistPassengerShares } from './passenger-shares.js';

// ── 类型 ────────────────────────────────────────────────────────────────

/**
 * 换人前的整单现场快照（写进 SWAP_ORDER_PASSENGER 审计的 before.snapshot）。
 *
 * 存在的理由：换人历史只记「旧名字 → 新名字」，运营复盘时还原不出「换人那一刻这单长什么样」——
 * 住哪家酒店、签证办到哪一步、这个人的结算价多少、换人费收了没有。这些值换完就被覆盖或清洗掉，
 * 事后无从查证，只能在换人事务里写库之前采一次。
 * 日期一律 YYYY-MM-DD 字符串；任何取不到的项为 null（快照是留痕，绝不因它失败而拦住换人）。
 */
export interface SwapBeforeSnapshot {
  chineseName: string | null;
  dateOfBirth: string | null;
  passportExpiry: string | null;
  /** 换人那一刻本单已盖章的酒店名（随机档未落位的行没有酒店，不进名单）；无则空数组。 */
  hotels: string[];
  /** 订单级签证要求（NEEDED / E_VISA / NOT_NEEDED …）。 */
  visaStatus: VisaRequirement | null;
  /** 被换的这位出行人当时是不是自备签。 */
  visaExempt: boolean;
  /** 该乘客的签证办理进度（VISA_APPLICATION 履约任务状态）；无任务为 null。 */
  visaTaskStatus: FulfillmentStatus | null;
  /** 该乘客的结算价（与《全岗总表》「结算价格」列同一权威口径）；算不出为 null。 */
  settlementCny: number | null;
}

/**
 * 换人重算结算价被跳过的原因（口径逐条见 resolveSwapRepriceQuote 的方法头）。
 * 跳过 = 只收换人费、不动结算价，界面据此告诉经办人「这一单要不要人工调价」。
 */
export type SwapRepriceSkipReason =
  | 'SETTLEMENT_LOCKED'
  | 'NO_CALENDAR'
  | 'NOT_CALENDAR_PRICED'
  | 'PRICING_KEY_CHANGED'
  | 'DIFF_OVER_CAP';

/** 换人重算结算价的取价结果（换人事务与换人预览端点共用）。 */
export interface SwapRepriceQuote {
  /**
   * 差价基准 = **这张单成交时用的那一天的日历每人价**（日历价 − 当时的代理立减）。
   *
   * 为什么是它、而不是这位乘客今天的每人份额（oldShareCny）：差价这件事之所以存在，
   * 唯一的原因是「结算价日历在下单之后动了」。日历比日历，才量得出日历动了多少。
   * 每人份额里还揉着单房差、杂费、按人调价、整单议价与售后费均摊 —— 拿它跟今天的
   * **裸日历价**比，等于把「我们跟这个代理谈定的价」和「手工调过的价」一并当成日历差额
   * 「纠正」回日历：手工价单会被多收，被换人还要替同行人的售后费买单。
   * 取不到（非日历成交 / 存量单无从判定）为 null，此时 repriceSkipped 必有值。
   */
  basisCny: number | null;
  /** 被换下去的那位在换人前的每人份额（与换人前快照 settlementCny 同源；只给界面看，不参与差价计算）。 */
  oldShareCny: number;
  /** 按换人当天日历重取的新出行人每人价；取不到为 null（此时 repriceSkipped 必有值）。 */
  newSettlementCny: number | null;
  /** 旧客要补的差价 = max(0, 基准 − 新价)；价没跌就是 0。 */
  diffCny: number;
  /** 取价来源：BUNDLE_SETTLEMENT_CALENDAR / FLIGHT_SETTLEMENT_CALENDAR；未取价为 null。 */
  calendarSource: string | null;
  settlementLocked: boolean;
  repriceSkipped?: SwapRepriceSkipReason;
  /** 取价明细（进调价行 metadata 与审计，供事后解释这个价怎么来的）。 */
  detail?: Record<string, unknown>;
}

/**
 * 「订正」通道会写、且需要在审计里逐项对比的身份字段。
 * 仅用于 correctPassenger 的 before/after 生成：只记真的变了的那几项。
 */
export const CORRECTABLE_IDENTITY_FIELDS = [
  'fullName',
  'lastName',
  'firstName',
  'chineseName',
  'documentNumber',
  'dateOfBirth',
  'gender',
  'nationality',
  'passportExpiry',
  'passportIssueDate',
  'passengerType',
] as const;

/**
 * 「票面身份里的姓名」三件套：订正通道判「这次动没动名字」「历史上动没动名字」都只认这三个。
 * chineseName 不在内（护照扩展字段，不上票面、不进航司系统）。
 */
export const CORRECTION_NAME_FIELDS = ['fullName', 'lastName', 'firstName'] as const;

/**
 * 只改姓名（证件号不动）时允许的最大编辑距离。比证件号那道闸（TYPO_MAX_EDIT_DISTANCE=2）松一格：
 * 姓名订正常见的漏音节 / 姓名颠倒一个字就能差到 3，而真换人差得远不止 3。
 */
export const CORRECTION_NAME_MAX_EDIT_DISTANCE = 3;

/**
 * 证件号规范化（订正通道口径）：trim + 大写。
 *
 * 护照号本来就是大写字母 + 数字，「e12345678」和「E12345678」是同一本护照。不规范化的话，
 * 一次纯大小写的「订正」会白写一次库、在审计里留一条根本没发生的变更，还会让同单/同班次
 * 查重按字面比对而漏判。建单入口不做这一层（历史存量口径），故只在订正写入前收口。
 * 导出供单测复用。
 */
export function normalizeDocumentNumber(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

/**
 * 姓名规范化（订正通道「证件号 + 姓名同改」闸的比对口径）：
 * 有 fullName 用 fullName，没有就用 `姓/名` 拼，统一 trim + 大写 + 折叠空白。
 * 两侧必须用同一种拼法，否则 `ZHANG/SAN` 与 `ZHANG SAN` 会被当成两个人。
 * 导出供单测复用。
 */
export function normalizeCorrectionName(
  fullName: string | null | undefined,
  lastName: string | null | undefined,
  firstName: string | null | undefined,
): string {
  const full = (fullName ?? '').trim();
  const composed = full !== '' ? full : `${(lastName ?? '').trim()}/${(firstName ?? '').trim()}`;
  return composed.replace(/\s+/g, ' ').trim().toUpperCase();
}

// ── 换人费标准档（运营可配）───────────────────────────────────────────────────
/** SystemSetting 键：换人费可选档位（逗号分隔的整数 CNY）。无记录 → 回落下面的缺省两档。*/
export const SWAP_FEE_OPTIONS_SETTING_KEY = 'orders.swapFeeOptionsCny';
/** 缺省档位：当前业务在用的两档。「按什么规则取哪一档」尚无成文口径，系统不猜，由经办人自己选。*/
export const DEFAULT_SWAP_FEE_OPTIONS_CNY: readonly number[] = [450, 550];

/**
 * 当前生效的换人费档位清单（换人弹窗预填 + 换人预览端点共用）。
 *
 * 读得到它的只有 ADMIN / STAFF / AGENT 三种身份（GET /orders/swap-fee-options 与换人预览各自
 * 在路由/服务里断言）：档位是我方与代理之间的收费口径，客户侧既没有换人这条通道，
 * 也不该看见「换人费有哪几档」。PUT 改档位仍限 ADMIN。
 *
 * 与房控超售上限（getHotelOversellCapRooms）同款读法：DB 配置优先，缺记录 / 脏值 / 测试里
 * 没铺 systemSetting delegate 时一律回落缺省 —— 档位只是**预填建议**，不是放行条件，
 * 配置读挂了也绝不能让换人跟着炸（金额最终以经办人提交的 feeCny 为准）。
 */
export async function getSwapFeeOptions(
  client: typeof prisma | Prisma.TransactionClient = prisma,
): Promise<number[]> {
  const delegate = (
    client as unknown as {
      systemSetting?: {
        findUnique: (args: { where: { key: string } }) => Promise<{ value: string } | null>;
      };
    }
  ).systemSetting;
  if (!delegate) return [...DEFAULT_SWAP_FEE_OPTIONS_CNY];
  const row = await delegate
    .findUnique({ where: { key: SWAP_FEE_OPTIONS_SETTING_KEY } })
    .catch(() => null);
  const parsed = (row?.value ?? '')
    .split(',')
    .map((s) => s.trim())
    // 先滤掉空片段再转数字：Number('') === 0，不滤会让「空配置」变成一档 ¥0。
    .filter((s) => s !== '')
    .map((s) => Number(s))
    // 上限与 PUT 校验同一个常量（POST_SALE_FEE_CAP_CNY，换人费本身也归它管）——
    // 两处各写各的数就会出现「存得进去、读回来被滤掉」的静默不一致。
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= POST_SALE_FEE_CAP_CNY);
  return parsed.length > 0 ? parsed : [...DEFAULT_SWAP_FEE_OPTIONS_CNY];
}

export async function readOrderSettlementCalendarAudit(
  client: Prisma.TransactionClient | typeof prisma,
  orderId: string,
): Promise<Record<string, unknown> | null> {
  const delegate = (
    client as unknown as {
      auditLog?: {
        findFirst: (args: unknown) => Promise<{ after: Prisma.JsonValue | null } | null>;
      };
    }
  ).auditLog;
  if (!delegate) return null;
  const row = await delegate
    .findFirst({
      where: {
        action: 'APPLY_SETTLEMENT_TOTAL',
        targetType: AuditTargetType.ORDER,
        targetId: orderId,
      },
      orderBy: { createdAt: 'desc' },
      select: { after: true },
    })
    .catch(() => null);
  if (!row) return null;
  const calendar = readJsonObject(row.after).settlementCalendar;
  if (calendar == null || typeof calendar !== 'object' || Array.isArray(calendar)) return null;
  return calendar as Record<string, unknown>;
}

// ════════════════════════════════════════════════════════════════════
// 前台自助（客户/代理侧）：护照资料补录 / 改签申请 / 电子行程单
// ════════════════════════════════════════════════════════════════════

/**
 * 出行人护照资料自助补录（前台客户本人 / 代理树内订单）。
 *
 * 规则：
 *   - 归属校验与 getOrder 同口径（assertCanView：客户仅本人单、代理仅自己+下级）。
 *   - 状态闸：仅 PENDING_PAYMENT / PAID / PROCESSING 可改；出票后锁定 → 409 ORDER_LOCKED。
 *   - 不允许改 fullName（换人请联系客服）——schema 层已拦，service 只接白名单字段。
 *   - passengerId 必须属于该订单，否则 404。
 *
 * 返回更新后的出行人（与 getOrder 详情同款序列化：剥离 passportPhotoUrl 大图，
 * 以 hasPassportPhoto 布尔代替）+ 改动字段名列表（审计用，绝不含字段值——PII 红线）。
 */
export async function selfUpdatePassenger(
  svc: OrderService,
  orderId: string,
  passengerId: string,
  input: SelfUpdatePassengerBody,
  requester: OrderRequester,
): Promise<{
    passenger: Record<string, unknown>;
    changedFields: string[];
    orderNumber: string;
  }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, userId: true, agentId: true, orderNumber: true },
  });
  if (!order) throw new NotFoundError('订单不存在');
  await svc.assertCanView(order, requester);

  if (!SELF_EDITABLE_PASSENGER_STATUSES.includes(order.status)) {
    throw new AppError('当前订单状态不可修改出行人资料，请联系客服', {
      statusCode: 409,
      code: 'ORDER_LOCKED',
    });
  }

  const passenger = await prisma.passenger.findUnique({
    where: { id: passengerId },
    select: { id: true, orderId: true, documentNumber: true },
  });
  if (!passenger || passenger.orderId !== orderId) {
    throw new NotFoundError('出行人不存在或不属于该订单');
  }

  // ── 补录反向闸：证件号从「待补」补成真值时，回头查一次同班次同证件号 ─────────────
  // 建单闸只在**建单那一刻**量得到，占位单转正的乘客当时证件是空的（量不到）。
  // 若同期还有人在同班次用这本真护照建过单，那份重复到今天才浮出水面：补录一落库，
  // 同一个人在同一班次上就实打实占着两份座。此路没有强录口子 —— 两张单总有一张要收口，
  // 与其让两份座位一直挂着，不如在这里拦住，让经办人先处理掉那一张。
  const nextDocumentNumber = input.documentNumber?.trim();
  const hadDocumentNumber = (passenger.documentNumber ?? '').trim() !== '';
  if (nextDocumentNumber && !hadDocumentNumber) {
    await svc.assertBackfilledDocumentNotDuplicated(orderId, nextDocumentNumber);
  }

  // 仅映射传入字段（与 swapPassenger 同款「undefined 即不动」口径）；日期字符串 → Date。
  const data: Prisma.PassengerUpdateInput = {};
  const changedFields: string[] = [];
  if (input.chineseName !== undefined) { data.chineseName = input.chineseName; changedFields.push('chineseName'); }
  if (input.gender !== undefined) { data.gender = input.gender; changedFields.push('gender'); }
  if (input.documentNumber !== undefined) { data.documentNumber = input.documentNumber; changedFields.push('documentNumber'); }
  if (input.dateOfBirth !== undefined) { data.dateOfBirth = new Date(input.dateOfBirth); changedFields.push('dateOfBirth'); }
  if (input.nationality !== undefined) { data.nationality = input.nationality; changedFields.push('nationality'); }
  if (input.passportExpiry !== undefined) { data.passportExpiry = new Date(input.passportExpiry); changedFields.push('passportExpiry'); }
  if (input.passportIssueDate !== undefined) { data.passportIssueDate = new Date(input.passportIssueDate); changedFields.push('passportIssueDate'); }
  if (input.passportIssueCountry !== undefined) { data.passportIssueCountry = input.passportIssueCountry; changedFields.push('passportIssueCountry'); }
  if (input.passportIssuePlace !== undefined) { data.passportIssuePlace = input.passportIssuePlace; changedFields.push('passportIssuePlace'); }
  if (input.passportPhotoUrl !== undefined) { data.passportPhotoUrl = input.passportPhotoUrl; changedFields.push('passportPhotoUrl'); }

  const updated = await prisma.passenger.update({ where: { id: passengerId }, data });
  return {
    passenger: serializePassengerRecord(updated as unknown as Record<string, unknown>),
    changedFields,
    orderNumber: order.orderNumber,
  };
}

/**
 * 补录护照后的同班次查重（证件号从空补成真值时调用）。
 *
 * 与建单闸同口径：只看本单各航段班次上「占座中」的订单，且排除本单自己。
 * 命中即抛 DuplicatePassengerError（同一个错误类型，前端已有的 DUPLICATE_PASSENGER
 * 处理逻辑照旧接得住）。本单没有任何有效航段（纯酒店/接送）→ 无从比对，直接放行。
 *
 * client：调用方在事务里时把 tx 传进来 —— 查重与随后的写入至少落在同一个事务里，
 * 中途不会读到别人尚未提交的中间态。**但这把锁只锁住本订单那一行**：与本单并发的
 * 「另一张单也在补录同一本护照」照样能同时判过（各锁各的订单行，谁都看不见对方），
 * 跨单的 TOCTOU 仍然存在，真正兜底的是事后对账与这条报错的指路。
 * 缺省全局单例，补录通道（不在事务里）行为一字未变。
 */
export async function assertBackfilledDocumentNotDuplicated(
  svc: OrderService,
  orderId: string,
  documentNumber: string,
  client: Prisma.TransactionClient = prisma,
): Promise<void> {
  const legs = await client.orderItem.findMany({
    where: { orderId, kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
    select: { flightScheduleId: true },
  });
  const scheduleIds = [
    ...new Set(legs.map((l) => l.flightScheduleId).filter((v): v is string => v != null)),
  ];
  if (scheduleIds.length === 0) return;

  const conflicts = await client.passenger.findMany({
    where: {
      // 大小写不敏感：库里既有大写也有小写的存量证件号，按字面比对会把同一本护照放过去。
      documentNumber: { equals: documentNumber, mode: 'insensitive' },
      orderId: { not: orderId },
      order: {
        status: { in: SEAT_HOLDING_STATUSES },
        items: { some: { flightScheduleId: { in: scheduleIds } } },
      },
    },
    select: { order: { select: { orderNumber: true } } },
  });
  if (conflicts.length === 0) return;

  const orderNumbers = [...new Set(conflicts.map((c) => c.order.orderNumber))];
  throw new DuplicatePassengerError(
    `该证件号已在同航班的有效订单中：${orderNumbers.join('、')}。` +
      '同一个人在同一班次占了两份座，请先处理掉其中一张单再补录护照。',
    {
      conflicts: [{ documentNumber, orderNumbers }] satisfies DuplicatePassengerConflict[],
    },
  );
}

/**
 * 签证台：出签后补录出行人的 出签日/生效日/有效期（仅 ADMIN/STAFF）。
 *
 * 规则：
 *   - 这三项是签证岗出签后才拿得到的信息，录单时无法预先知道（票务岗反馈：录单时不需要），
 *     已从录单表单移除；改由签证台在出签后走本方法补录。
 *   - passengerId 必须属于该订单，否则 404。
 *   - 字段值为 YYYY-MM-DD 字符串写入；null 清空该字段；undefined（未传）不动。
 *   - 无状态闸——出签后各订单状态（PAID/PROCESSING/TICKETED…）都可能需要补录/更正，不比照
 *     selfUpdatePassenger 的 SELF_EDITABLE_PASSENGER_STATUSES 限制（那是前台自助补护照资料的口径）。
 *
 * 返回更新后的出行人（同 selfUpdatePassenger 序列化口径）+ before/after（审计用）。
 */
export async function updatePassengerVisaDates(
  svc: OrderService,
  orderId: string,
  passengerId: string,
  input: UpdatePassengerVisaDatesBody,
  actor: { userId: string; role: UserRole },
): Promise<{
    passenger: Record<string, unknown>;
    orderNumber: string;
    before: { visaIssueDate: string | null; visaEffectiveDate: string | null; visaExpiry: string | null };
    after: { visaIssueDate: string | null; visaEffectiveDate: string | null; visaExpiry: string | null };
  }> {
  if (!actorCan(actor, 'orders.passengers.write')) {
    throw new ForbiddenError('仅运营/管理员可录入签证日期');
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true },
  });
  if (!order) throw new NotFoundError('订单不存在');

  const passenger = await prisma.passenger.findUnique({
    where: { id: passengerId },
    select: {
      id: true,
      orderId: true,
      visaIssueDate: true,
      visaEffectiveDate: true,
      visaExpiry: true,
    },
  });
  if (!passenger || passenger.orderId !== orderId) {
    throw new NotFoundError('出行人不存在或不属于该订单');
  }

  const toYmd = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
  const before = {
    visaIssueDate: toYmd(passenger.visaIssueDate),
    visaEffectiveDate: toYmd(passenger.visaEffectiveDate),
    visaExpiry: toYmd(passenger.visaExpiry),
  };

  const toDateOrNull = (v: string | null | undefined): Date | null | undefined =>
    v === undefined ? undefined : v === null ? null : new Date(v);
  const data: Prisma.PassengerUpdateInput = {};
  if (input.visaIssueDate !== undefined) data.visaIssueDate = toDateOrNull(input.visaIssueDate);
  if (input.visaEffectiveDate !== undefined) data.visaEffectiveDate = toDateOrNull(input.visaEffectiveDate);
  if (input.visaExpiry !== undefined) data.visaExpiry = toDateOrNull(input.visaExpiry);

  const updated = await prisma.passenger.update({ where: { id: passengerId }, data });
  const after = {
    visaIssueDate: toYmd(updated.visaIssueDate),
    visaEffectiveDate: toYmd(updated.visaEffectiveDate),
    visaExpiry: toYmd(updated.visaExpiry),
  };

  return {
    passenger: serializePassengerRecord(updated as unknown as Record<string, unknown>),
    orderNumber: order.orderNumber,
    before,
    after,
  };
}

/**
 * 票务台：回填 / 订正 / 清空某位出行人的真实 PNR 与电子票号（ADMIN/STAFF）。
 *
 * 为什么需要这个方法：出票目前走沙箱（履约 worker 延时后生成号并自动写回 Passenger），
 * 真实航司出票之后系统里没有任何人工录入口 —— 票务拿到真票号也录不进去。本方法就是那个入口。
 *
 * 边界（有意克制，别把它做成第二个「改单」）：
 *   · **只动 pnr / eticketNumber 两列**。不碰订单状态、不碰履约任务、不碰开票三维布尔
 *     （开票模型是「出票进度」口径，见 docs/口径决议.md，与票号是两回事，不许在这里联动）。
 *   · **不发行程单邮件**。沙箱出票会自动发，人工回填**不发** —— 票务边录边发，客人一天收
 *     十几封改来改去的行程单。要发就走订单详情既有的「重发行程单邮件」，人点，人负责。
 *   · 状态闸只有一条：**回收站里的单不给回填**。已取消 / 已退款的单照样放行 ——
 *     真实场景恰恰是「票出了、单取消了，退票要拿票号去跟航司对」，这时候拦住才是帮倒忙。
 *
 * 号的**来源**（沙箱自动出票 vs 人工回填）不落库、不加列，靠审计区分：
 * 人工回填必留一条 BACKFILL_PASSENGER_TICKET，查审计就知道这个号是谁什么时候录的。
 */
export async function updatePassengerTicket(
  svc: OrderService,
  orderId: string,
  passengerId: string,
  input: UpdatePassengerTicketBody,
  actor: { userId: string; role: UserRole },
): Promise<{
    passenger: Record<string, unknown>;
    orderNumber: string;
    passengerName: string;
    before: { pnr: string | null; eticketNumber: string | null };
    after: { pnr: string | null; eticketNumber: string | null };
    /** 本次真正变了值的字段（两个都没变时为空数组 —— 回填同一个号是幂等的，不是错误）。 */
    changedFields: Array<'pnr' | 'eticketNumber'>;
  }> {
  if (!actorCan(actor, 'orders.passengers.write')) {
    throw new ForbiddenError('仅运营/管理员可回填票号');
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, deletedAt: true },
  });
  if (!order) throw new NotFoundError('订单不存在');
  if (order.deletedAt !== null) {
    throw new ConflictError('订单在回收站，请先恢复该单再回填票号');
  }

  const passenger = await prisma.passenger.findUnique({
    where: { id: passengerId },
    select: { id: true, orderId: true, fullName: true, pnr: true, eticketNumber: true },
  });
  if (!passenger || passenger.orderId !== orderId) {
    throw new NotFoundError('出行人不存在或不属于该订单');
  }

  const before = { pnr: passenger.pnr, eticketNumber: passenger.eticketNumber };
  // schema 已保证三者互斥（clear 与两个值不同框、且至少给一个），这里只负责翻译成落库值。
  const next = {
    pnr: input.clear === true ? null : input.pnr === undefined ? before.pnr : input.pnr,
    eticketNumber:
      input.clear === true
        ? null
        : input.eticketNumber === undefined
          ? before.eticketNumber
          : input.eticketNumber,
  };

  const changedFields: Array<'pnr' | 'eticketNumber'> = [];
  if (next.pnr !== before.pnr) changedFields.push('pnr');
  if (next.eticketNumber !== before.eticketNumber) changedFields.push('eticketNumber');

  // 一个字段都没变：不写库（免得白刷 updatedAt），如实回 changedFields: [] 让调用方照实说。
  const updated =
    changedFields.length === 0
      ? await prisma.passenger.findUniqueOrThrow({ where: { id: passengerId } })
      : await prisma.passenger.update({
          where: { id: passengerId },
          data: { pnr: next.pnr, eticketNumber: next.eticketNumber },
        });

  return {
    passenger: serializePassengerRecord(updated as unknown as Record<string, unknown>),
    orderNumber: order.orderNumber,
    passengerName: passenger.fullName,
    before,
    after: { pnr: updated.pnr, eticketNumber: updated.eticketNumber },
    changedFields,
  };
}

/**
 * 换人：把订单里某位出行人就地换成新人（改身份字段），并按需重置开票/签证状态、加换人费。
 *
 * body：{ lastName?, firstName?, fullName?, documentNumber?, dateOfBirth?, gender?,
 *         nationality?, resetInvoice?, resetVisa?, feeCny?, feeLabel?, note? }
 *
 * 单事务内：
 *   1. 更新该乘客的身份字段（仅传入的字段；fullName/姓名拆分与下单口径一致）。
 *   2. resetInvoice → order.invoiceStatus = NONE（新出行人需重新开票）。
 *   3. resetVisa → 该订单所有 VISA 履约任务回到 PENDING（新出行人需重新送签）。
 *   4. 真换人（证件号变化）且结算价未锁 → 按**换人当天**的结算价日历重取新出行人每人价，
 *      与旧份额的差额落一条挂在该乘客名下的 SWAP_REPRICE 调价行（口径见 resolveSwapRepriceQuote）。
 *   5. feeCny>0 → order.adjustmentCny += feeCny + adjustments 流水（SWAP_FEE）；
 *      旧份额高于新价时再加一条 SWAP_PRICE_DIFF（换人差价）。两条都记在**被换下去的人**头上、
 *      不参与每人均摊（excludeFromPerPax）。
 *
 * 返回更新后的订单（serializeOrder）+ 审计用的原/新身份。
 */
export async function swapPassenger(
  svc: OrderService,
  orderId: string,
  passengerId: string,
  input: {
    lastName?: string;
    firstName?: string;
    fullName?: string;
    chineseName?: string;
    documentNumber?: string;
    dateOfBirth?: string;
    gender?: import('@prisma/client').Gender;
    nationality?: string;
    // 新出行人的护照有效期 / 签发日（YYYY-MM-DD）：换人 = 录入一个新人的护照。
    // 证件号变化时旧人的这两项会被清空，本请求带的值即新人的值（缺有效期且本单按人出行 → 400）。
    passportExpiry?: string;
    passportIssueDate?: string;
    // title/passengerType/visaExempt/singleRoom 已由 swapPassengerBodySchema 暴露透传；
    // 真换人时用它们作为「显式新值」覆盖默认清洗值（前向兼容：不传则保持既有清洗行为）。
    title?: string;
    passengerType?: PassengerType;
    visaExempt?: boolean;
    singleRoom?: boolean;
    resetInvoice?: boolean;
    resetVisa?: boolean;
    feeCny?: number;
    feeLabel?: string;
    note?: string;
  },
  actor: { userId: string; role: UserRole; agentId?: string },
): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      passengerId: string;
      before: {
        fullName: string;
        documentNumber: string;
        /** 换人前的整单现场快照（供订单页「换人历史」还原换人那一刻的样子）。 */
        snapshot: SwapBeforeSnapshot;
      };
      after: {
        fullName: string;
        documentNumber: string;
        /** 换人重算结算价的结果（未跑重算 = null；跳过时 repriceSkipped 说明为什么）。 */
        reprice: {
          /** 差价基准 = 成交那天的日历每人价（换人费也一并回给审计，见 L10）。 */
          basisCny: number | null;
          oldShareCny: number;
          newSettlementCny: number | null;
          diffCny: number;
          feeCny: number;
          calendarSource: string | null;
          repriceSkipped: SwapRepriceSkipReason | null;
          itemId: string | null;
          itemAmountCny: number;
        } | null;
        /** 代理填的换人费不在配置档位里（运营复核时重点看这一笔）；运营/管理员不判。 */
        feeOffList?: boolean;
      };
      resetInvoice: boolean;
      resetVisa: boolean;
      visaTasksReset: number;
      feeCny: number;
      // 证件号变化触发的换人清洗：已清除旧出行人残留的生日/护照/签证/出生地信息
      clearedProfile: boolean;
    };
  }> {
  // ── 换人权限口径（2026-09 拍板）────────────────────────────────────────
  // 运营/管理员：照旧全量。
  // 代理：可以换自家（含下级）单里的人，运营事后复核 —— 客人临时换人时不必再等运营上班。
  //   但代理拿不到「状态重置权」：
  //     · resetVisa 强制 true —— 换的是另一个人，旧签证进度对新人无效，必须回队重新送签。
  //     · resetInvoice 忽略 —— 开票位属于财务口径，代理不该动；已开票的单代理干脆不许换人（见事务内闸）。
  //
  // 换人费口径（2026-09 拍板，改）：**换人费由经办人自己填**，代理也不例外 ——
  // 换人费是业务常数（清单见 getSwapFeeOptions，界面按清单预填），谁换人谁填这一笔，
  // 运营复核时三次核对。此前代理侧强制 feeCny=0，等于把「代理换的人不收费」写死进系统，
  // 运营事后要另开一笔调价才补得回来，账上看不出这笔钱是哪次换人产生的。
  // 金额边界仍由 schema 的 postSaleFeeSchema 兜（整数、≥0、≤ 上限），此处只做同款取整兜底。
  //   · **费用名（feeLabel）只有运营/管理员能改**：代理写什么都按「换人费」入账 —— 这一笔
  //     进的是我方财务台账，名字由代理自定义，对账时同一笔钱会有 N 种叫法，分类当场作废。
  //   · 代理填的金额不在配置档位里 → 不拦（档位只是建议，特殊情况本来就要按实际收），
  //     但在审计里打 feeOffList，运营复核时一眼能挑出来。
  const isInternalActor = actor.role === UserRole.ADMIN || actor.role === UserRole.STAFF;
  if (!isInternalActor) {
    if (!actorCan(actor, 'orders.passengers.swap')) {
      throw new ForbiddenError('仅运营/管理员可换人');
    }
    await svc.assertPassengerEditScope(orderId, actor);
  }
  const feeCny = Math.max(0, Math.trunc(input.feeCny ?? 0));
  const feeLabel = isInternalActor ? input.feeLabel : undefined;
  const resetInvoice = isInternalActor ? Boolean(input.resetInvoice) : false;
  const resetVisa = isInternalActor ? Boolean(input.resetVisa) : true;

  // OrderMutation 内核（审查根因 R5）：事务 + 订单行锁 + 事务内审计 + 守恒断言
  //（换人只动应收 / 售后费：已收、座位、房量、成本四维前后必须恒等，不平整事务回滚）。
  // 换人没有 requestToken（前端不带、路由 schema 也没有），幂等留待后续批次单独拍板。
  // 下方按列读锁行的 SELECT … FOR UPDATE 保留原样：同一事务内对同一行重复上锁无副作用，
  // 它读出来的列后面各闸都要用。
  const result = await runOrderMutation({
    orderId,
    actor,
    action: 'SWAP_PASSENGER',
    conserve: { unchanged: ['paid', 'seats', 'rooms', 'cost'], label: '换人' },
    // 换人改应收 / 售后费（换人费不摊、差价重算）→ 份额随人（同一乘客 id）重算落库（R1）。
    persistShares: true,
  }, async (ctx) => {
    const tx = ctx.tx;
    // Order 行锁（与改期 rescheduleOrderItem / worker 超时释放 / 到账入账同一把 FOR UPDATE 行锁）：
    // 换人要读-改-写 adjustmentCny/adjustments，无锁会与并发改期/换人 lost-update（一方覆盖另一方的流水）。
    const orderRows = await tx.$queryRaw<
      Array<{
        id: string;
        orderNumber: string;
        adjustmentCny: number;
        adjustments: Prisma.JsonValue;
        status: OrderStatus;
        deletedAt: Date | null;
        // 订单级签证状态：矛盾组合硬闸要读（见下方「1b3」）。
        visaStatus: VisaRequirement | null;
        // 三维开票位：代理换人闸要读（票已出的单代理不许换人，见下方）。
        outboundInvoiced: boolean | null;
        returnInvoiced: boolean | null;
        systemInvoiced: boolean | null;
        // 结算价锁：锁着的单不重算结算价（财务已按这个应收对过账），见下方「1f」。
        settlementLocked: boolean | null;
      }>
    >`SELECT id, "orderNumber", "adjustmentCny", adjustments, status, "deletedAt", "visaStatus", "outboundInvoiced", "returnInvoiced", "systemInvoiced", "settlementLocked" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const order = orderRows[0];
    if (!order) throw new NotFoundError('订单不存在');

    // ── 代理换人闸：票已出的单不给代理换 ───────────────────────────────────
    // 开票位一旦置起，票面身份已经发出去了：换人要连带重置开票、可能还要退改签费，
    // 这是财务与票务的口径，代理自助搞不定。运营走换人并勾选「重置开票」照旧可做。
    // 读的是刚 FOR UPDATE 锁住的那一行，与并发开票流转严格串行。
    if (
      !isInternalActor &&
      (order.outboundInvoiced === true ||
        order.returnInvoiced === true ||
        order.systemInvoiced === true)
    ) {
      throw new BadRequestError('票已出，换人请联系运营');
    }

    // ── 代理换人闸②：已订座 / 已出票的单不给代理换 ─────────────────────────
    // 三个开票位是**财务**口径（发票开没开），跟票务口径（座位订没订、票号出没出）是两码事：
    // 内部录单的单常年一张发票都没开，却早就在航司系统里订好座、出好票了 —— 只看开票位的话，
    // 代理能在已出票的单上直接把名字换掉，航司那边的票面身份对不上，值机当场卡死。
    // 所以再看两处票务现势：订单状态已出票/已完成，或该乘客身上已经有 PNR / 电子票号。
    // 运营不受此闸（走换人并勾选「重置开票」照旧可做，退改签由票务另行处理）。
    if (
      !isInternalActor &&
      (order.status === OrderStatus.TICKETED || order.status === OrderStatus.COMPLETED)
    ) {
      throw new BadRequestError('已订座/已出票，换人请联系运营');
    }

    // ── 有效订单守卫（HIGH 修复）：与改期 / 升舱同款双闸 ────────────────────
    // 换人不只是改个名字：它会通过 feeCny 往 adjustmentCny 里加收换人费，还会重置开票位与签证任务。
    // 在已取消 / 已退款 / 超时 / 回收站单上换人 → 这些死单会凭空长出一笔「欠款」并重新进应收报表，
    // 已结清的退款单账面被改写。所以入口硬性要求：deletedAt=null 且 status ∈ 占座态。
    // 读的是刚 FOR UPDATE 锁住的那一行，与并发状态流转严格串行（不会读到过期快照）。
    if (order.deletedAt) {
      throw new BadRequestError('订单在回收站（已软删），不可换人；如需操作请先恢复');
    }
    if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
      throw new BadRequestError(
        `订单当前状态（${zhStatus(order.status)}）不可换人：仅占座中的有效订单可换人（已取消/已退款/超时订单请勿换人）`,
      );
    }

    const passenger = await tx.passenger.findUnique({
      where: { id: passengerId },
      // visaExempt：换人价回滚要读旧客的自备签状态（true→false 时把减免加回来，见下方 1d）。
      // passengerType：出生日期变化时权威重派生的回退口径（见下方 1b2）——同一人只是改错生日
      // 时，不该把已有的儿童/婴儿类型误判丢回默认成人。
      select: {
        id: true,
        orderId: true,
        fullName: true,
        documentNumber: true,
        visaExempt: true,
        passengerType: true,
        // pnr / eticketNumber：代理换人闸②要读（票务现势，见上方开票位那段口径说明）。
        pnr: true,
        eticketNumber: true,
        // 以下三项只服务「换人前现场快照」（审计 before.snapshot），不参与任何业务判定。
        chineseName: true,
        dateOfBirth: true,
        passportExpiry: true,
      },
    });
    if (!passenger || passenger.orderId !== orderId) {
      throw new NotFoundError('出行人不存在或不属于该订单');
    }
    // 乘客级票务现势：这一位已经订上座 / 出了票 → 代理换不了（口径同上方状态闸）。
    if (
      !isInternalActor &&
      ((passenger.pnr ?? '').trim() !== '' || (passenger.eticketNumber ?? '').trim() !== '')
    ) {
      throw new BadRequestError('已订座/已出票，换人请联系运营');
    }
    const beforeIdentity = {
      fullName: passenger.fullName,
      documentNumber: passenger.documentNumber,
    };

    // ── 1. 更新身份字段（仅传入的字段；fullName 时按下单口径自动拆姓/名兜底）──
    const data: Prisma.PassengerUpdateInput = {};
    if (input.fullName !== undefined) {
      data.fullName = input.fullName;
      // 客户端没显式给 lastName/firstName 时，用 fullName 自动拆（与 passengerToData 同口径）
      if (input.lastName === undefined || input.firstName === undefined) {
        const { lastName: autoLast, firstName: autoFirst } = splitPassengerFullName(
          input.fullName,
        );
        if (input.lastName === undefined) data.lastName = autoLast || null;
        if (input.firstName === undefined) data.firstName = autoFirst || null;
      }
    }
    if (input.lastName !== undefined) data.lastName = input.lastName;
    if (input.firstName !== undefined) data.firstName = input.firstName;
    if (input.chineseName !== undefined) data.chineseName = input.chineseName;
    if (input.documentNumber !== undefined) data.documentNumber = input.documentNumber;
    if (input.dateOfBirth !== undefined) data.dateOfBirth = new Date(input.dateOfBirth);
    if (input.gender !== undefined) data.gender = input.gender;
    if (input.nationality !== undefined) data.nationality = input.nationality;
    // 护照有效期 / 签发日：带了就写（真换人＝新人的护照；证件号没变则等价于一次补录，
    // 与 selfUpdatePassenger 同款「undefined 即不动」口径，绝不在这里清空）。
    if (input.passportExpiry !== undefined) data.passportExpiry = new Date(input.passportExpiry);
    if (input.passportIssueDate !== undefined) {
      data.passportIssueDate = new Date(input.passportIssueDate);
    }
    if (input.title !== undefined) data.title = input.title;
    if (input.passengerType !== undefined) data.passengerType = input.passengerType;
    // visaExempt 不在这里直写：自备签列由签证状态机的 SWAP_PASSENGER 转移决定（见下方 1b），
    // 与身份列同一条 UPDATE 落库（writePassengerVisaExempt 的 extra）。
    if (input.singleRoom !== undefined) data.singleRoom = input.singleRoom;

    // ── 1b. 换人检测：证件号变化 = 真换人（非改错别字）→ 清除旧出行人残留的
    //        生日 / 护照 / 签证 / 出生地 / 票号 / 乘客级选项，避免新出行人套用前一个人的证件与状态。
    //        「除非请求同时提供了新值」：上面已按 input 赋过新值的字段（chineseName / gender /
    //        dateOfBirth / title / passengerType / visaExempt / singleRoom）保留新值；本请求没带的一律清洗。
    //        证件号没变（改拼写）不触发。
    const newDocument = input.documentNumber?.trim();
    const documentChanged =
      newDocument !== undefined && newDocument !== '' && newDocument !== passenger.documentNumber;

    // ── 1b·闸. 换人费只在**真换人**时能收 ──────────────────────────────────────
    // 这个端点同时承担「改错别字 / 补生日 / 改自备签」这些非换人的小修（证件号没变），
    // 它们跟换人服务费没有半点关系。此前不判，界面上换人费输入框留着上一次的值、
    // 或者经办人顺手填了一笔，就会在一次改错别字里凭空多收客人几百块，而且流水上写着
    //「换人费」、乘客名单里根本找不到被换的人 —— 账面上无从解释。宁可拒绝，让人看清自己在做什么。
    if (!documentChanged && feeCny > 0) {
      throw new BadRequestError('未换人不能收取换人费');
    }

    // ── 1b·闸0. 换人 = 录入一个新人的护照 → 按人出行的单必须带新出行人的护照有效期 ────────
    // 口径与建单一致（PER_PERSON_TRAVEL_KINDS / refineRequiredPassportExpiry，同一常量复用）：
    // 含机票 / 套餐 / 签证行的订单，每位出行人都要有护照有效期。下方 1b 会把旧人的
    // passportExpiry 清成 null（数据上正确——旧人的有效期绝不能套到新人头上），若这里不强制，
    // 换人后新人的有效期就永远是空的，出票 / 送签 / 开票全程无人察觉（已发生过的线上事故）。
    // 纯酒店 / 接送单不在此列：那类单的出行人可能只是联系人占位，没有护照资料，强制会打死正常操作。
    if (documentChanged && !input.passportExpiry) {
      const perPersonKinds = Object.values(OrderItemKind).filter((k) =>
        PER_PERSON_TRAVEL_KINDS.has(k),
      );
      const perPersonItemCount = await tx.orderItem.count({
        where: { orderId, kind: { in: perPersonKinds } },
      });
      if (perPersonItemCount > 0) {
        throw new BadRequestError('换人须填写新出行人护照有效期（YYYY-MM-DD）');
      }
    }

    if (documentChanged) {
      // 表单可编辑但本次没填 → 显式置空（不残留前一个人的值）
      if (data.chineseName === undefined) data.chineseName = null;
      if (data.gender === undefined) data.gender = null;
      // 生日随人走：带了新值即用新值（上面已赋），否则置空——列已改为可空
      // （migration 20260708140000_passenger_dob_nullable），彻底解决换人残留旧生日。
      if (data.dateOfBirth === undefined) data.dateOfBirth = null;
      data.placeOfBirth = null;
      // 护照证件信息随人走：本次带了新值的（有效期 / 签发日，上面已赋）保留新值，其余置空。
      data.passportPhotoUrl = null;
      if (data.passportIssueDate === undefined) data.passportIssueDate = null;
      data.passportIssueCountry = null;
      data.passportIssuePlace = null;
      if (data.passportExpiry === undefined) data.passportExpiry = null;
      // 已签发签证信息随人走
      data.visaNumber = null;
      data.visaType = null;
      data.visaIssueDate = null;
      data.visaEffectiveDate = null;
      data.visaExpiry = null;
      data.visaPlaceOfIssue = null;
      data.visaCountryOfApplication = null;
      // 航司票号随人走：旧人的 PNR / 电子票号绝不能留给新人（否则行程单/出票照印旧票号）。
      data.pnr = null;
      data.eticketNumber = null;
      // 乘客级选项回落安全默认（未显式带新值时）：
      //   · visaExempt=false → 新人默认「随套餐办签」，不会被签证台漏掉（旧人自备签的 true 绝不继承）
      //     —— 这一条由签证状态机的 SWAP_PASSENGER 转移给出（见紧接其后的 swapVisa）。
      //   · singleRoom=false → 新人默认「拼房」（业务默认；房控按新人重新分房）。
      //   · title=null / passengerType=ADULT（schema 默认）→ 敬称/乘客类型随人走，不继承旧人。
      if (data.singleRoom === undefined) data.singleRoom = false;
      if (data.title === undefined) data.title = null;
      if (data.passengerType === undefined) data.passengerType = PassengerType.ADULT;
      // 说明：nationality 是必填非空列，无法「置空」；请求带了新值即用新值（上面已赋），
      // 未带时只能保留旧值（不猜默认国籍——猜错会污染出票/签证）。彻底根治需 schema 层在真换人时
      // 强制 nationality，留待拥有 orders.schemas.ts 的下一棒收口。
    }

    // ── 1b·闸. 签证矛盾组合硬闸：换人把最后一位随团办签的人也带成自备签 ─────────
    // 订单级仍是「需要签证 / 电子签」时，本单会再没有人要我方送签 → 签证任务被撤、
    // 签证台看不见这单（判定见 visa-need.ts）。只拒绝、不替客人改任何标记。
    // 只在本次结果为「自备签」时才查名单（换回随团办签、或本就不是自备签的请求零额外开销）。
    // 上方已拦掉取消族终态与回收站单，故此处无需再判「不参与履约」。
    // 自备签列由状态机的 SWAP_PASSENGER 转移决定：显式带值 > 真换人回落 false（旧人自备签的
    // true 绝不继承）> 保持原值；送签进度不动（现状）。事件给出明确值时 write 带 visaExempt，
    // 与身份列同一条 UPDATE 落库（下方 writePassengerVisaExempt 的 extra）。
    const swapVisa = transitionPassengerVisa(
      {
        orderVisaStatus: order.visaStatus,
        visaExempt: passenger.visaExempt,
        visaSubmissionStatus: null,
        allPassengersExempt: false,
      },
      { type: 'SWAP_PASSENGER', visaExempt: input.visaExempt, documentChanged },
    );
    if (!swapVisa.ok) throw new ConflictError(swapVisa.reason);
    const swapVisaWrite = swapVisa.write.passenger;
    const resolvedVisaExempt = swapVisa.facts.visaExempt === true;
    if (resolvedVisaExempt && orderVisaStatusRequiresVisa(order.visaStatus)) {
      const roster = await tx.passenger.findMany({
        where: { orderId },
        select: { id: true, visaExempt: true },
      });
      const projected = roster.map((p) =>
        p.id === passengerId ? { visaExempt: true } : { visaExempt: p.visaExempt },
      );
      assertNoVisaContradiction({ visaStatus: order.visaStatus, passengers: projected });
    }

    // ── 1b2. 出行人类型服务端权威派生（覆盖客户端传值）：出生日期变化（改错别字或真换人都算）时，
    //        若订单能定出最早出发日（机票行），按「出发日 − 出生日期」用 derivePtcByAge 重算
    //        passengerType 并覆盖 —— 与建单（createOrder → passengerToData）同一口径的权威兜底，
    //        入口层已尽量派生，这里是权威兜底，堵住换人/改生日时手选类型不跟着改的口子。
    //        无新出生日期（本次未改）或订单定不出出发日 → 保留上面已赋的值（客户端传值 / 换人默认）。
    if (data.dateOfBirth !== undefined && data.dateOfBirth !== null) {
      const flightItems = await tx.orderItem.findMany({
        where: { orderId, kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
        select: { flightSchedule: { select: { departureTime: true } } },
      });
      const departureDate = earliestFlightDeparture(
        flightItems.map((it) => ({ kind: 'FLIGHT', flightSchedule: it.flightSchedule })),
      );
      if (departureDate) {
        // 回退口径：本次显式给的新值 > 已有的旧值（同一人订正生日不该丢类型）> 兜底成人。
        const fallbackPassengerType =
          (data.passengerType as PassengerType | undefined) ??
          input.passengerType ??
          passenger.passengerType ??
          PassengerType.ADULT;
        data.passengerType = ptcToPassengerType(
          derivePtcByAge(data.dateOfBirth as Date, departureDate, fallbackPassengerType),
        );
      }
    }

    // ── 1c. 重复证件号校验（与 createOrder 同口径，swap 之前缺失）：真换人时，换入的证件号
    //        不得已存在于「同航班班次的占座中订单」里（否则同一人同班次被重复占座/出票）。
    if (documentChanged) {
      const flightItems = await tx.orderItem.findMany({
        where: { orderId, kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
        select: { flightScheduleId: true },
      });
      const scheduleIds = flightItems
        .map((i) => i.flightScheduleId)
        .filter((sid): sid is string => sid !== null);
      if (scheduleIds.length > 0) {
        const dup = await tx.passenger.findFirst({
          where: {
            documentNumber: newDocument,
            id: { not: passengerId }, // 排除被换的这条本身
            order: {
              status: { in: SEAT_HOLDING_STATUSES },
              deletedAt: null,
              items: { some: { flightScheduleId: { in: scheduleIds } } },
            },
          },
          select: { order: { select: { orderNumber: true } } },
        });
        if (dup) {
          throw new DuplicatePassengerError(
            `换入的证件号 ${newDocument} 已在同航班的有效订单（${dup.order.orderNumber}）中，不能重复换入`,
            { conflicts: [{ documentNumber: newDocument, orderNumbers: [dup.order.orderNumber] }] },
          );
        }
      }
    }

    // ── 1e. 换人前的整单现场快照（审计 before.snapshot）─────────────────────
    // 换人历史只记「旧名字→新名字」是不够的：运营复盘时要看的是「换人那一刻这单长什么样」——
    // 住哪家酒店、签证办到哪一步、这个人的结算价是多少。这些数据换完就被覆盖/清洗掉了，
    // 事后无从还原，所以必须在同一个事务里、写库之前采集。
    // 采集失败不能拖垮换人（快照是留痕，不是放行条件）→ 缺失项一律给 null / 空数组。
    const beforeSnapshot = await svc.buildSwapBeforeSnapshot(tx, orderId, passengerId, {
      chineseName: passenger.chineseName ?? null,
      dateOfBirth: passenger.dateOfBirth ?? null,
      passportExpiry: passenger.passportExpiry ?? null,
      visaExempt: passenger.visaExempt === true,
      visaStatus: order.visaStatus ?? null,
    });

    // 身份列 + 自备签列一条 UPDATE：状态机给出自备签写入时走唯一写点（extra 带身份列），
    // 否则本次不碰签证列，只是一条普通的身份订正。
    if (swapVisaWrite?.visaExempt !== undefined) {
      await writePassengerVisaExempt(tx, passengerId, { visaExempt: swapVisaWrite.visaExempt }, data);
    } else {
      await tx.passenger.update({ where: { id: passengerId }, data });
    }

    // ── 1d. 换人价回滚（自备签 true→false 时把旧客的自备签减免加回来）──────────────────
    // 证件变更会把 visaExempt 强制回落 false（新客进签证台随团办签，见上方 1b），但订单 BUNDLE 行
    // 仍扣着旧客的自备签减免 selfVisaDeductTotal → 新客要送签、钱却少收。这里按「每人自备签减免」把
    // 减免精确撤销（正向 adjustmentCny → effectivePayable/尾款自然回升），与改期费/换人费同款结构化留痕。
    // 选型：不重算整条 BUNDLE 行金额（重算含房晚/升舱/占座多输入、风险高），只回滚这笔每人减免——
    //   自洽且最小侵入；减免本就是按人计（每人一次 selfVisaDeductCny），撤一人即加回一份。
    // 只处理 true→false（少收的钱路径）；false→true（新客改自备签）不在此自动打折，避免误减，
    //   需要时走显式重定价。
    const oldVisaExempt = passenger.visaExempt === true;
    const newVisaExempt = swapVisa.facts.visaExempt === true;
    // 幂等：同一乘客的自备签减免只冲一次。多次换人 true→false→true→false 会反复命中 true→false，
    // 若不去重会每次都把减免加回来 → 过冲多收。检查 order.adjustments 是否已有该乘客的
    // SWAP_VISA_DEDUCT_REVERSAL（下方入账时按 passengerId 留痕），有则本次不再冲。
    const priorAdjustments = Array.isArray(order.adjustments)
      ? (order.adjustments as unknown as OrderAdjustmentEntry[])
      : [];
    const alreadyReversedForPassenger = priorAdjustments.some(
      (e) => e?.type === 'SWAP_VISA_DEDUCT_REVERSAL' && e?.passengerId === passengerId,
    );
    let visaDeductReversalCny = 0;
    if (oldVisaExempt && !newVisaExempt && !alreadyReversedForPassenger) {
      const bundleItems = await tx.orderItem.findMany({
        where: { orderId, kind: OrderItemKind.BUNDLE },
        select: { metadata: true },
      });
      for (const bi of bundleItems) {
        const addOns = (
          bi.metadata as {
            addOns?: { selfProvidedVisaCount?: unknown; selfVisaDeductCny?: unknown };
          } | null
        )?.addOns;
        const count = typeof addOns?.selfProvidedVisaCount === 'number' ? addOns.selfProvidedVisaCount : 0;
        const rate = typeof addOns?.selfVisaDeductCny === 'number' ? addOns.selfVisaDeductCny : 0;
        // 只对「确实按自备签给过减免」的套餐行回滚一份每人减免（count>0 且 rate>0）。
        if (count > 0 && rate > 0) {
          visaDeductReversalCny += Math.max(0, Math.trunc(rate));
        }
      }
    }

    // ── 1f. 换人重算结算价（只在真换人时跑：证件号变了才是「另一个人上飞机」）────────
    // 口径（2026-09 拍板）：新出行人的结算价按**换人当天**的结算价日历、同一出行日期重取；
    // 旧客那份份额若更高，差额（旧 − 新，只取正）连同换人费一起挂在**被换下去的那个人**头上，
    // 绝不摊给留下来的同行人与新客（不摊的机制见 per-pax-share.ts 的 spreadableAdjustmentCny）。
    // 价格没变（最常见）→ 差额 0、不落任何行。取不到价 / 结算价已锁 → 跳过重算，只收换人费。
    //
    // 落账方式与「取消航段手续费」同款：直接建一条 endpoint-only 原因码的调价行 + 重算 total，
    // 不走 _addPriceAdjustmentWithinTx —— 那个内核会自己再锁一次行、再写一次 adjustments 与 total，
    // 与本事务末尾那一次合并写（步骤 4）互相覆盖，且它的 reasonCode 只收人工四类。
    let repriceQuote: SwapRepriceQuote | null = null;
    let repriceItemId: string | null = null;
    let repriceDeltaCny = 0;
    let repriceRowDescription: string | null = null;
    let repricedSubtotalCny: number | null = null;
    /** 本单已计提佣金（>0 才留佣金基数漂移审计，见下方 M2 段）；null = 没计提过 / 没重算。 */
    let repriceCommissionCny: number | null = null;
    if (documentChanged) {
      repriceQuote = await svc.resolveSwapRepriceQuote(tx, orderId, passengerId);
      const { basisCny, newSettlementCny } = repriceQuote;
      if (basisCny != null && newSettlementCny != null && !repriceQuote.repriceSkipped) {
        // 日历比日历：delta = 换人当天的日历价 − 成交那天的日历价。
        // 两端在取价内核里已取整（复审 H1），这里再取一次只是把「整数」这件事写死在落库口径上。
        const deltaCny = Math.round(newSettlementCny - basisCny);
        // 差额为 0（日历没动，最常见）→ 不落空行；可正可负（涨价 → 新客补，降价 → 新客少付）。
        if (Math.abs(deltaCny) >= 0.005) {
          const row = buildPriceAdjustmentItem({
            amountCny: deltaCny,
            reasonCode: 'SWAP_REPRICE',
          });
          const createdReprice = await tx.orderItem.create({
            data: {
              orderId,
              kind: row.kind,
              description: row.description,
              quantity: 1,
              unitPrice: new Prisma.Decimal(row.unitPrice),
              amount: new Prisma.Decimal(row.amount),
              totalCostCny: new Prisma.Decimal(row.totalCostCny),
              metadata: {
                ...row.metadata,
                swapReprice: true,
                // basisCny 是这次减法的左边（成交那天的日历价）；oldShareCny 只做展示留痕。
                basisCny,
                oldShareCny: repriceQuote.oldShareCny,
                newSettlementCny,
                calendarSource: repriceQuote.calendarSource,
                ...(repriceQuote.detail ? { calendarDetail: repriceQuote.detail } : {}),
              } as Prisma.InputJsonValue,
              // 挂在这一位乘客名下：新出行人的每人结算价 = 均摊 + 本行净额 = 重取的日历价。
              passengerId,
            },
          });
          repriceItemId = createdReprice.id;
          repriceDeltaCny = deltaCny;
          repriceRowDescription = row.description;
          // 重算 subtotal/total（口径同事后调价：Σ 全部行金额，当前 total = subtotal）。
          const agg = await tx.orderItem.aggregate({
            where: { orderId },
            _sum: { amount: true },
          });
          repricedSubtotalCny = round2(Number(agg._sum.amount ?? 0));
          // ── 佣金基数漂移留痕（复审 M2）───────────────────────────────────
          // 佣金在订单转 PAID 时按当时的价格基数一次性计提，之后任何改价都**不重算佣金**。
          // 改结算价 / 改归属两条路早就为此各留一条 WARNING 审计，换人重算却把 total 悄悄改了
          // 却什么也不留 —— 财务对账时看到佣金与应收对不上，翻不出是哪一步动的。
          // 这里与改结算价那条路同一个 action、同一批字段，方便财务用一个筛选条件全捞出来。
          repriceCommissionCny = await sumAccruedCommissionCny(tx, orderId);
        }
      }
    }

    // ── 2. resetInvoice → 开票状态回 NONE + 三维开票位（去/回/系统）一并清零（新出行人重开票）──
    if (resetInvoice) {
      await tx.order.update({
        where: { id: orderId },
        data: {
          invoiceStatus: InvoiceStatus.NONE,
          outboundInvoiced: false,
          returnInvoiced: false,
          systemInvoiced: false,
        },
      });
    }

    // ── 3. resetVisa → 该订单 VISA 履约任务回 PENDING（新出行人重新送签）──
    //   只重置活动态（IN_PROGRESS/CONFIRMED/FAILED）→ PENDING；绝不碰 CANCELLED。
    //   CANCELLED 是取消族订单终态化任务（见 _updateStatusWithinTx P2-16）留下的终态记录——
    //   若把它一并 PENDING 化，会「复活」已取消订单的履约任务（看板凭空冒出可执行任务、统计口径错乱）。
    //   与 A2 一致：CANCELLED 永远冻结为终态，任何"重开/复活"路径都不得触碰。
    //   任务级重置的唯一写点在状态机模块（resetVisaTaskProgress），SQL 形状照抄。
    let visaTasksReset = 0;
    if (resetVisa) {
      visaTasksReset = await resetVisaTaskProgress(tx, orderId);
    }

    // ── 3b. 自备签变更 → 签证任务事件驱动同步（条10）────────────────────────
    // 换人通道是「乘客级自备签」在存量订单上的唯一写入口（改自备签的 PATCH 会被
    // resolvePassengerPatchChannel 判成换人语义、走到这里；证件号变化的真换人也会把
    // visaExempt 强制回落 false）。旧行为只补不删：全员改成自备签之后，那条 PENDING
    // 签证任务还挂在签证台上永远办不掉；反过来最后一位自备签客人换成随团办签时，
    // 又没人给他补任务。这里按权威口径重算一次，把任务对齐到最新需求。
    // 只在自备签真的变了时才跑——没变就没有新事件，不给每次换人平白加几次查询。
    if (oldVisaExempt !== newVisaExempt) {
      await syncVisaTasksForOrder(tx, orderId, { userId: actor.userId, role: actor.role });
    }

    // ── 4. 售后费用流水：换人价回滚（SWAP_VISA_DEDUCT_REVERSAL）+ 换人费（SWAP_FEE）合并写一次 ──
    // 两项都进 adjustmentCny，合并成一次 order.update（避免先后两写彼此覆盖 adjustments 数组）。
    const swapAdjustments: OrderAdjustmentEntry[] = [];
    if (visaDeductReversalCny > 0) {
      swapAdjustments.push({
        type: 'SWAP_VISA_DEDUCT_REVERSAL',
        label: '撤销自备签减免（换人转随团办签）',
        amountCny: visaDeductReversalCny,
        at: new Date().toISOString(),
        by: actor.userId,
        note: input.note,
        passengerId, // 幂等去重锚点：同一乘客只冲一次
      });
    }
    if (feeCny > 0) {
      swapAdjustments.push({
        type: 'SWAP_FEE',
        label: feeLabel || '换人费',
        amountCny: feeCny,
        at: new Date().toISOString(),
        by: actor.userId,
        note: input.note,
        // 换人费是**被换下去的那个人**的账：留他的姓名/证件号（他已不在乘客名单里，
        // 只有这条流水还记得这笔钱是谁产生的），并且不参与每人均摊。
        passengerName: beforeIdentity.fullName,
        passengerDocument: beforeIdentity.documentNumber,
        excludeFromPerPax: true,
      });
    }
    // 换人差价（成交那天的日历价 − 换人当天的日历价，只取正）：挂在被换下去的人头上、不摊。
    // 取整：这笔钱进 Order.adjustmentCny（Int 列），一分钱的小数就能把整个换人事务打回 500。
    const swapPriceDiffCny = repriceQuote?.repriceSkipped
      ? 0
      : Math.round(repriceQuote?.diffCny ?? 0);
    if (swapPriceDiffCny > 0) {
      swapAdjustments.push({
        type: 'SWAP_PRICE_DIFF',
        label: '换人差价',
        amountCny: swapPriceDiffCny,
        at: new Date().toISOString(),
        by: actor.userId,
        note: input.note,
        passengerName: beforeIdentity.fullName,
        passengerDocument: beforeIdentity.documentNumber,
        excludeFromPerPax: true,
      });
    }
    // ── 4b. 重算调价行的台账留痕（PRICE_ADJUSTMENT 流水）───────────────────────
    // 与补房差 / 事后调价同一条既有约定：**PRICE_ADJUSTMENT 型流水只记账、不进 adjustmentCny**
    //（钱已经随调价行进了 total，见 addPriceAdjustment / addRoomSupplement 的「仅记录用」注释）。
    // 因此这条不带 excludeFromPerPax —— 它压根不在均摊基数里，spreadableAdjustmentCny 也就
    // 不需要（更不能）把它扣一次；带上反而会把 total 里的钱从每人份额里再减一遍，双重扣减。
    // 决策记在这里：沿用既有约定，不引入 ledgerOnly 这种只此一处的新标记。
    const ledgerEntries: OrderAdjustmentEntry[] = [];
    if (repriceItemId && Math.abs(repriceDeltaCny) >= 0.005) {
      ledgerEntries.push({
        type: 'PRICE_ADJUSTMENT',
        label: repriceRowDescription ?? PRICE_ADJUSTMENT_REASON_LABEL.SWAP_REPRICE,
        amountCny: repriceDeltaCny,
        at: new Date().toISOString(),
        by: actor.userId,
        reasonCode: 'SWAP_REPRICE',
        note: input.note,
        passengerId,
      });
    }

    // 售后费流水（换人费 / 换人差价 / 自备签减免回滚）+ 重算台账流水 + 重算后的 subtotal/total
    // 合并写一次 —— 分两次写会彼此覆盖 adjustments 数组（同一事务内后写的读的是事务开始时的快照）。
    if (swapAdjustments.length > 0 || ledgerEntries.length > 0 || repricedSubtotalCny != null) {
      const existingArr = Array.isArray(order.adjustments)
        ? (order.adjustments as Prisma.JsonArray)
        : [];
      const log = [
        ...existingArr,
        ...([...swapAdjustments, ...ledgerEntries] as unknown as Prisma.JsonArray),
      ] as Prisma.InputJsonValue;
      // 只有售后费流水进 adjustmentCny；台账流水（PRICE_ADJUSTMENT）的钱已经在 total 里。
      // Math.round 是最后一道兜底：adjustmentCny 是 Int 列，三笔来源（换人费 / 自备签减免回滚 /
      // 换人差价）各自已经取整，这里只保证任何将来新增的流水也不会带小数进来（复审 H1）。
      const delta = Math.round(swapAdjustments.reduce((s, e) => s + e.amountCny, 0));
      await tx.order.update({
        where: { id: orderId },
        data: {
          ...(swapAdjustments.length > 0
            ? { adjustmentCny: order.adjustmentCny + delta }
            : {}),
          ...(swapAdjustments.length > 0 || ledgerEntries.length > 0
            ? { adjustments: log }
            : {}),
          ...(repricedSubtotalCny != null
            ? {
                subtotal: new Prisma.Decimal(repricedSubtotalCny),
                total: new Prisma.Decimal(repricedSubtotalCny),
              }
            : {}),
        },
      });
    }

    const afterPassenger = await tx.passenger.findUniqueOrThrow({
      where: { id: passengerId },
      select: { fullName: true, documentNumber: true },
    });

    // ── 换人重算撞上已计提佣金 → 单独留一条 WARNING 审计（复审 M2），**与换人同一事务** ──
    // 与「改结算价」「改归属」两条路同一个 action、同一批字段：佣金按计提当时的价格基数一次算死，
    // 换人重算改了 total 却不重算佣金，财务要能一眼捞出所有「基数已变、佣金没动」的单。
    // 原先在事务提交后 await 写；改进事务是内核口径——资金动作的留痕与动作同生共死。
    if (repricedSubtotalCny != null && repriceCommissionCny !== null) {
      await ctx.audit({
        action: 'SETTLEMENT_PRICE_CHANGED_AFTER_COMMISSION',
        targetType: 'ORDER',
        targetId: orderId,
        targetLabel: order.orderNumber,
        before: { accruedCommissionCny: repriceCommissionCny },
        after: {
          total: repricedSubtotalCny.toString(),
          orderItemId: repriceItemId,
          // 佣金不随换人重算，这条审计就是「基数已变、佣金没动」的留痕。
          commissionRecalculated: false,
          reason: '换人重算结算价',
          passengerId,
        },
        severity: AuditSeverity.WARNING,
      });
    }

    return {
      beforeIdentity,
      beforeSnapshot,
      afterIdentity: afterPassenger,
      visaTasksReset,
      clearedProfile: documentChanged,
      // 佣金基数漂移（M2）：换人重算真的改了 total 且本单已计提佣金（审计已在上方事务内写）。
      repriceCommissionCny: repricedSubtotalCny != null ? repriceCommissionCny : null,
      repricedTotalCny: repricedSubtotalCny,
      repriceItemId,
      // 重算留痕：审计要能解释「新客这个价是怎么来的、旧客为什么补这笔差价」。
      reprice: repriceQuote
        ? {
            basisCny: repriceQuote.basisCny,
            oldShareCny: repriceQuote.oldShareCny,
            newSettlementCny: repriceQuote.newSettlementCny,
            diffCny: swapPriceDiffCny,
            calendarSource: repriceQuote.calendarSource,
            repriceSkipped: repriceQuote.repriceSkipped ?? null,
            itemId: repriceItemId,
            itemAmountCny: repriceDeltaCny,
          }
        : null,
    };
  });

  const finalOrder = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: ORDER_FULL_INCLUDE,
  });

  // 代理填的换人费不在配置档位里 → 审计打标（不拦，见上方口径）。档位读挂了一律不打标：
  // 档位只是建议，读不到就没有「off list」这回事，不能凭读失败给人扣个异常帽子。
  const feeOffList =
    actor.role === UserRole.AGENT && feeCny > 0
      ? await getSwapFeeOptions(prisma)
          .then((options) => !options.includes(feeCny))
          .catch(() => false)
      : false;

  return {
    // 对外脱敏：换人的返回按操作者角色脱敏（ADMIN/STAFF 全量，其余剥离内部字段 + 逐项拆价）。
    order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
    audit: {
      orderNumber: finalOrder.orderNumber,
      passengerId,
      before: { ...result.beforeIdentity, snapshot: result.beforeSnapshot },
      after: {
        fullName: result.afterIdentity.fullName,
        documentNumber: result.afterIdentity.documentNumber,
        reprice: result.reprice ? { ...result.reprice, feeCny } : null,
        ...(feeOffList ? { feeOffList: true } : {}),
      },
      // 记的是**实际生效**的口径（代理换人被强制成 resetVisa=true、费用名固定「换人费」），
      // 不是请求里写了什么 —— 审计要能解释账面为什么这样变。
      resetInvoice,
      resetVisa,
      visaTasksReset: result.visaTasksReset,
      feeCny,
      clearedProfile: result.clearedProfile,
    },
  };
}

/**
 * 换人前的整单现场快照（审计 before.snapshot 的唯一生产者）。
 *
 * 只读、不写；在换人事务内、写库之前调用，拿到的是「换人那一刻」的现场。
 * 采集是留痕而非放行条件：任何一项取不到就给 null / 空数组，绝不因为快照失败把换人拦下来。
 *
 * 各项口径：
 *   · hotels —— 本单 HOTEL / BUNDLE 行上已盖章的酒店名（随机档未落位的行没有 hotelRoomTypeId，
 *     自然不出现在名单里）。去重保序。
 *   · visaTaskStatus —— 该乘客的签证办理进度。VISA_APPLICATION 履约任务挂在 OrderItem 上，
 *     指定乘客的行 orderItem.passengerId 非空、整单行为空 → 先找这个人的专属任务，
 *     没有再回退到整单任务；都没有 → null。
 *   · settlementCny —— 这个人的结算价，走与《全岗总表》完全同一条权威口径
 *     （computePerPaxShares + groupPassengerAdjustments，即 perPaxSettlementByPassenger 的算法；
 *      此处直接调底层两函数而非导出层，避免 service ↔ export-templates 循环依赖）。
 */
export async function buildSwapBeforeSnapshot(
  svc: OrderService,
  tx: Prisma.TransactionClient,
  orderId: string,
  passengerId: string,
  passengerFacts: {
    chineseName: string | null;
    dateOfBirth: Date | null;
    passportExpiry: Date | null;
    visaExempt: boolean;
    visaStatus: VisaRequirement | null;
  },
): Promise<SwapBeforeSnapshot> {
  // 日期口径：出生日期 / 护照有效期都是「日期本身」（passportExpiry/passportIssueDate 是
  // @db.Date，dateOfBirth 按 UTC 零点写入），按 UTC 直接切片 —— 与签证日期补录
  // （updatePassengerVisaDates）同一个 toYmd 写法，绝不能折 +8 时区（会把日期整体推后一天）。
  const toYmd = (d: Date | null | undefined): string | null =>
    d instanceof Date ? d.toISOString().slice(0, 10) : null;

  const snapshot: SwapBeforeSnapshot = {
    chineseName: passengerFacts.chineseName,
    dateOfBirth: toYmd(passengerFacts.dateOfBirth),
    passportExpiry: toYmd(passengerFacts.passportExpiry),
    hotels: [],
    visaStatus: passengerFacts.visaStatus,
    visaExempt: passengerFacts.visaExempt,
    visaTaskStatus: null,
    settlementCny: null,
  };

  // 一次查询同时喂三样：酒店名、签证任务、每人结算价（少一次往返，也少一处口径漂移）。
  const snapOrder = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      total: true,
      adjustmentCny: true,
      // 售后费流水：可摊基数要扣掉换人费/换人差价（excludeFromPerPax），见 spreadableAdjustmentCny。
      adjustments: true,
      passengers: { select: { id: true } },
      items: {
        select: {
          id: true,
          kind: true,
          amount: true,
          description: true,
          passengerId: true,
          metadata: true,
          hotelRoomType: { select: { hotel: { select: { name: true } } } },
          fulfillmentTasks: { select: { type: true, status: true, updatedAt: true } },
        },
      },
    },
  });
  if (!snapOrder || !Array.isArray(snapOrder.items)) return snapshot;

  const hotelNames = new Set<string>();
  for (const it of snapOrder.items) {
    if (it.kind !== OrderItemKind.HOTEL && it.kind !== OrderItemKind.BUNDLE) continue;
    const name = it.hotelRoomType?.hotel?.name;
    if (typeof name === 'string' && name.trim() !== '') hotelNames.add(name.trim());
  }
  snapshot.hotels = [...hotelNames];

  // 签证任务：本人专属行优先，其次整单行；同一档里取最近更新的一条。
  const pickLatest = (
    rows: Array<{ status: FulfillmentStatus; updatedAt: Date | null }>,
  ): FulfillmentStatus | null => {
    let best: { status: FulfillmentStatus; at: number } | null = null;
    for (const r of rows) {
      const at = r.updatedAt instanceof Date ? r.updatedAt.getTime() : 0;
      if (!best || at >= best.at) best = { status: r.status, at };
    }
    return best?.status ?? null;
  };
  const visaTaskRows = snapOrder.items.flatMap((it) =>
    (it.fulfillmentTasks ?? [])
      .filter((t) => t.type === FulfillmentType.VISA_APPLICATION)
      .map((t) => ({ status: t.status, updatedAt: t.updatedAt ?? null, owner: it.passengerId ?? null })),
  );
  snapshot.visaTaskStatus =
    pickLatest(visaTaskRows.filter((r) => r.owner === passengerId)) ??
    pickLatest(visaTaskRows.filter((r) => r.owner === null));

  // 每人结算价：与《全岗总表》「结算价格」列同源。乘客 id 升序传入 —— 分级余数那一分钱
  // 兜给数组最后一位，不排序会随任何一次 UPDATE 漂移（口径说明见 perPaxSettlementByPassenger）。
  const roster = Array.isArray(snapOrder.passengers) ? snapOrder.passengers : [];
  if (roster.length > 0) {
    const { byPassenger } = groupPassengerAdjustments(
      snapOrder.items.map((it) => ({
        id: it.id,
        amount: Number(it.amount?.toString() ?? 0),
        description: it.description,
        passengerId: it.passengerId ?? null,
        metadata: it.metadata,
      })),
    );
    const { rows } = computePerPaxShares({
      totalCny: Number(snapOrder.total?.toString() ?? 0),
      // 可摊售后费：换人费/换人差价挂在被换下去的人头上，不摊给同行人（spreadableAdjustmentCny）。
      adjustmentCny: spreadableAdjustmentCny(snapOrder),
      passengerIds: [...roster.map((p) => p.id)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      netByPassenger: new Map(
        Object.entries(byPassenger).map(([pid, bucket]) => [pid, bucket.netCny]),
      ),
    });
    snapshot.settlementCny = rows.find((r) => r.passengerId === passengerId)?.shareCny ?? null;
  }

  return snapshot;
}

/**
 * 换人重算结算价：取价内核（换人事务与换人预览端点共用的**唯一**口径）。
 *
 * 业务口径（2026-09 拍板，经复审修正）：**差价只因为结算价日历动了才存在**，
 * 所以要拿日历比日历 —— 基准是「这张单成交那天的日历每人价」（basisCny），
 * 对手方是「换人当天的日历每人价」（newSettlementCny）：
 *   · delta = 新 − 基准 → 挂在该乘客名下的一条 SWAP_REPRICE 调价行（可正可负，进 total）；
 *   · diff  = max(0, 基准 − 新) → 旧客留下的差价，与换人费一起记在**被换下去的那个人**头上
 *     （不摊给同行人与新客，机制见 per-pax-share.ts 的 spreadableAdjustmentCny）。
 * 这单上的其它任何一笔钱都不许动。常见情形是日历没动 → delta 与 diff 都是 0、不落任何行。
 *
 * 为什么**不能**拿这位乘客今天的每人份额（oldShareCny）当基准（复审 BLOCK 的那条）：
 * 每人份额 = 均摊（含单房差/杂费/整单议价/售后费）+ 这个人身上的按人调价净额。
 * 拿它去跟今天的**裸日历价**相减，等于把「手工谈定的价」「售后补收的钱」一并当成日历差额
 * 「纠正」回日历 —— 手工价单会被系统按日历多收，被换下去的人还要替同行人的售后费买单。
 * oldShareCny 保留下来只做展示（界面上告诉经办人这个人原来算多少钱），不进任何算式。
 *
 * 基准（basisCny）从哪来，按下面的顺序，取不到就 NOT_CALENDAR_PRICED（只收换人费、不动结算价）：
 *   1. 这位乘客名下已经有 SWAP_REPRICE 行（这单换过人了）→ 取最近那一行的 newSettlementCny。
 *      连续换人时基准要跟着走，否则第二次换人会拿第一次换之前的价再算一遍（重复计差）。
 *   2. 整单 SETTLEMENT 行带 calendarPerPaxCny（2026-09 起建单落的日历基准戳，见
 *      buildSettlementTotalItem）→ 基准 = calendarPerPaxCny − calendarDiscountPerPaxCny。
 *   3. 存量单（没有基准戳）：回建单那条 APPLY_SETTLEMENT_TOTAL 审计，把
 *      after.settlementCalendar 的 lines[].pricePerPersonCny 当每人价（LEGACY_AUDIT）。
 *      blob 缺失 / 口径不明 / 本单拆过 / 有按人 SETTLEMENT 覆盖行 → NOT_CALENDAR_PRICED。
 *      **绝不再拿 settlementTotalCny ÷ 人数派生**：那个总价含加项，除出来不是日历价（复审 H1/H2）。
 *
 * 换人当天取价口径（对齐录单：resolveBundleSettlementCalendarTotal / resolveFlightSettlementCalendarTotal）：
 *   · 只对**代理单**取价 —— 结算价日历本来就是同业价表，散客单的价不出自这张表（散客走套餐
 *     percent-off + 散客立减），拿同业价去重算散客单等于按代理价卖给客人。
 *   · 套餐单：本单唯一一条「配了日历键（档次+晚数）」的 BUNDLE 行 → 日历每人价 − 每人立减
 *     （resolveAgentSettlementDiscount，与录单把立减写成独立 DISCOUNT 行同一净效果）。
 *     **立减减不减看基准那一位**（basis.discountApplied，复审 H3）：建单侧只在没有任何手工价
 *     通道时才自动命中立减，换人侧若无条件再减一次，手工价单的基准没减、今天减了，
 *     差额里就凭空多出一整笔立减 —— 减法两边必须同口径。
 *     加项（升舱/单住/婴儿价/指定酒店加价…）不再需要单独设闸：它们从来不在基准里，
 *     日历比日历这道减法碰不到它们（原 ADDON_NOT_ATTRIBUTABLE 因此撤掉）。
 *   · 纯机票单：逐条经济舱 FLIGHT 行按「航班号 × 该段出发地本地日」取每人价后求和（往返各查各的）。
 *   · 其余一律不取价（repriceSkipped）—— **宁可不重算，也不算错**：
 *       - NO_CALENDAR：非代理单 / 无日历键 / 多条套餐行分不清这人算哪一条 / 当日无价 /
 *         含非经济舱航段（日历不分舱位）/ 取到的价 ≤ 0；
 *       - NOT_CALENDAR_PRICED：这张单不是按日历成交的（手工价 / 议价 / 每人价），或存量单
 *         判不出当时的日历基准 —— 没有基准就没有「日历动了多少」这回事；
 *       - PRICING_KEY_CHANGED：这张单成交之后改过档（换 bundleId → 档次/晚数变了）或改过期
 *         （出发日挪了，行价按设计冻结、差额另有调价行收），今天查的已经是日历上的**另一格**。
 *         同一格的今昔两价相减才是「日历动了多少」；跨格相减量到的是改档/改期的价差，
 *         那笔钱在各自的通道里早已收过一次，再收一次就是重复收费。故基准戳连**定价键**
 *         一起盖章（档次×晚数×出发日 / 逐航段航班号×出发日），换人当天先比键、再比价；
 *       - DIFF_OVER_CAP：差额超出调价上限 —— 多半是数据不对，不静默落一笔巨额调价；
 *       - SETTLEMENT_LOCKED：结算价已锁（财务已按这个应收对过账），只收换人费、不动结算价。
 *
 * 只读，不写任何一行；换人事务与 GET 预览端点跑的是同一份代码（预览所见 = 换人所得）。
 */
export async function resolveSwapRepriceQuote(
  svc: OrderService,
  db: Prisma.TransactionClient | typeof prisma,
  orderId: string,
  passengerId: string,
): Promise<SwapRepriceQuote> {
  // 结算价日历是整数每人价（SettlementRate.pricePerPersonCny 是 Int）。基准 / 新价 / 差额 /
  // 差价全线取整：diff 会直接写进 Order.adjustmentCny（**Int 列**），带小数会整事务 500 回滚；
  // 调价行金额也跟着整数，免得订单上冒出「−¥199.67」这种没人解释得清的行（复审 H1）。
  const toInt = (n: number): number => Math.round(n);
  // 日历表 / 立减规则都在换人这同一个事务里读：换人事务已经把 Order 行 FOR UPDATE 锁住了，
  // 走事务外的 default client 等于在锁外另开一条连接读价 —— 与事务快照不是同一时刻（复审 L2）。
  const txClient = db as unknown as PrismaClient;
  const skip = (
    reason: SwapRepriceSkipReason,
    oldShareCny: number,
    settlementLocked: boolean,
    detail?: Record<string, unknown>,
    basisCny: number | null = null,
  ): SwapRepriceQuote => ({
    basisCny,
    oldShareCny,
    newSettlementCny: null,
    diffCny: 0,
    calendarSource: null,
    settlementLocked,
    repriceSkipped: reason,
    ...(detail ? { detail } : {}),
  });

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      agentId: true,
      total: true,
      adjustmentCny: true,
      adjustments: true,
      settlementLocked: true,
      // 只要 id：每人份额按乘客 id 升序均摊（分级余数兜给最后一位）。
      // 基准早已改成「日历每人价」，不再拿总价 ÷ 占座人数派生，所以婴儿占不占座与这里无关。
      passengers: { select: { id: true } },
      // 拆过的单不认基准：拆单改的是人数与产品构成，成交那一刻的日历快照没跟着改。
      _count: { select: { splitsIn: true, splitsOut: true } },
      items: {
        select: {
          id: true,
          kind: true,
          amount: true,
          description: true,
          passengerId: true,
          metadata: true,
          quantity: true,
          // 连续换人时取**最近**那条 SWAP_REPRICE 行的价当下一次的基准。
          createdAt: true,
          flightCabin: true,
          flightScheduleId: true,
          hotelCheckIn: true,
          visaIntendedDate: true,
          bundle: {
            select: { settlementTier: true, settlementNights: true, ...BUNDLE_ROUTE_SELECT },
          },
          flightSchedule: {
            select: {
              departureTime: true,
              departureTz: true,
              flight: { select: { flightNumber: true } },
            },
          },
        },
      },
    },
  });
  if (!order || !Array.isArray(order.items) || !Array.isArray(order.passengers)) {
    return skip('NO_CALENDAR', 0, false, { note: '订单数据不完整，跳过重算' });
  }
  const settlementLocked = order.settlementLocked === true;

  // ── 旧份额：与换人前快照 settlementCny 逐分同源（computePerPaxShares + 按乘客调价净额）──
  const { byPassenger } = groupPassengerAdjustments(
    order.items.map((it) => ({
      id: it.id,
      amount: Number(it.amount?.toString() ?? 0),
      description: it.description,
      passengerId: it.passengerId ?? null,
      metadata: it.metadata,
    })),
  );
  const { rows } = computePerPaxShares({
    totalCny: Number(order.total?.toString() ?? 0),
    adjustmentCny: spreadableAdjustmentCny(order),
    // 乘客 id 升序：分级余数那一分钱兜给最后一位，不排序会随任何一次 UPDATE 漂移。
    passengerIds: [...order.passengers.map((p) => p.id)].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
    netByPassenger: new Map(
      Object.entries(byPassenger).map(([pid, bucket]) => [pid, bucket.netCny]),
    ),
  });
  const oldShareCny = round2(rows.find((r) => r.passengerId === passengerId)?.shareCny ?? 0);

  if (settlementLocked) return skip('SETTLEMENT_LOCKED', oldShareCny, true);
  if (!order.agentId) {
    return skip('NO_CALENDAR', oldShareCny, false, { note: '非代理单，不走结算价日历' });
  }

  // ── 差价基准：这张单成交那天的日历每人价（口径与取法见方法头）───────────────
  const basis = await svc.resolveSwapRepriceBasis(db, orderId, order, passengerId);
  if (basis.basisCny == null) {
    return skip('NOT_CALENDAR_PRICED', oldShareCny, false, { note: basis.note });
  }
  const basisCny = basis.basisCny;

  const departYmd = deriveOrderDepartDate(
    order.items as unknown as Array<Record<string, unknown>>,
  );
  const bundleItems = order.items.filter((it) => it.kind === OrderItemKind.BUNDLE);
  let newSettlementCny: number | null = null;
  let calendarSource: string | null = null;
  let detail: Record<string, unknown> = {};

  if (bundleItems.length > 0) {
    const configured = bundleItems.filter(
      (it) => it.bundle?.settlementTier != null && it.bundle?.settlementNights != null,
    );
    if (configured.length !== 1) {
      return skip(
        'NO_CALENDAR',
        oldShareCny,
        false,
        {
          note:
            configured.length === 0 ? '套餐未配结算价日历' : '本单多条日历套餐行，无法确定取价行',
        },
        basisCny,
      );
    }
    if (!departYmd) {
      return skip('NO_CALENDAR', oldShareCny, false, { note: '本单无法确定出发日期' }, basisCny);
    }
    const row = configured[0];
    // 加项（升舱/单住/婴儿价/儿童折扣/自备签减免/指定酒店加价）不设闸：它们从来不在基准里，
    // 「今天的日历价 − 成交那天的日历价」这道减法碰不到它们，重算不会把谁身上的加项抹掉。
    const tier = row.bundle!.settlementTier as SettlementTier;
    const nights = row.bundle!.settlementNights as number;
    // 航线从套餐绑定航班派生（bundle-route.ts 唯一入口）：套餐没绑航班 = 没有航线 = 无结算价，
    // 不重算（绝不拿某条既有航线兜底——那是按错线的价给人算差价）。
    const routeKey = bundleRouteKey(row.bundle!);
    if (routeKey == null) {
      return skip(
        'NO_CALENDAR',
        oldShareCny,
        false,
        { note: '套餐未绑航班，无结算价', tier, nights, departDate: departYmd },
        basisCny,
      );
    }
    // 定价键先比（在查价之前）：改档换了 bundleId → 档次/晚数/航线变了，改期挪了出发日 ——
    // 都把这张单挪到了日历的另一格，今昔两个价不是同一格的价，相减出来的不是日历浮动。
    const todayKey: SwapCalendarKey = {
      source: 'BUNDLE_SETTLEMENT_CALENDAR',
      routeKey,
      tier,
      nights,
      departDate: departYmd,
    };
    const keyMismatch = keyChangedDetail(basis.key, todayKey);
    if (keyMismatch) {
      return skip('PRICING_KEY_CHANGED', oldShareCny, false, keyMismatch, basisCny);
    }
    const rate = await getSettlementRate(routeKey, tier, nights, departYmd, txClient);
    if (!rate) {
      return skip(
        'NO_CALENDAR',
        oldShareCny,
        false,
        { note: '该出发日期的结算价未维护', routeKey, tier, nights, departDate: departYmd },
        basisCny,
      );
    }
    // 立减只在「基准也减过」时才减（复审 H3）：基准没减 → 今天也不减，减法两边同口径。
    const hit = basis.discountApplied
      ? await resolveAgentSettlementDiscount(
          order.agentId,
          routeKey,
          tier,
          nights,
          departYmd,
          txClient,
        )
      : null;
    const perPersonCny = toInt(rate.pricePerPersonCny - (hit?.discountPerPersonCny ?? 0));
    calendarSource = 'BUNDLE_SETTLEMENT_CALENDAR';
    detail = {
      routeKey,
      tier,
      nights,
      departDate: departYmd,
      pricePerPersonCny: rate.pricePerPersonCny,
      discountPerPersonCny: hit?.discountPerPersonCny ?? 0,
      // 连续换人要接力这一位：下一次换人拿这条 SWAP_REPRICE 行当基准时照它决定减不减立减。
      discountApplied: basis.discountApplied,
      // 定价键同样接力：下一次换人拿这条行当基准时，要能比出「这之后又改没改档/改期」。
      calendarKey: todayKey,
    };
    newSettlementCny = perPersonCny;
  } else {
    const flightRows = order.items.filter(
      (it) => it.kind === OrderItemKind.FLIGHT && it.flightScheduleId != null,
    );
    if (flightRows.length === 0) {
      return skip('NO_CALENDAR', oldShareCny, false, { note: '本单无可取价的产品行' }, basisCny);
    }
    // 机票结算价日历的键是「航班号 × 出发日」，没有舱位这一维：非经济舱按它取价 = 按经济舱价重算。
    if (
      flightRows.some((it) => it.flightCabin != null && it.flightCabin !== CabinClass.ECONOMY)
    ) {
      return skip('NO_CALENDAR', oldShareCny, false, { note: '本单含非经济舱航段，日历不分舱位' }, basisCny);
    }
    // 先把这张单今天落在日历上的哪几格（航班号 × 该段出发地本地日）列全，比完键再查价：
    // 改期把航段挪到了别的日期 → 已经不是成交那几格，今昔相减量到的不是日历浮动。
    const legs: Array<{ flightNumber: string; departDate: string }> = [];
    for (const it of flightRows) {
      const sched = it.flightSchedule;
      if (!sched?.departureTime || !sched.flight?.flightNumber) {
        return skip('NO_CALENDAR', oldShareCny, false, { note: '航段班次信息缺失' }, basisCny);
      }
      legs.push({
        flightNumber: sched.flight.flightNumber,
        departDate: localDate(sched.departureTime, sched.departureTz),
      });
    }
    const todayKey: SwapCalendarKey = { source: 'FLIGHT_SETTLEMENT_CALENDAR', legs };
    const keyMismatch = keyChangedDetail(basis.key, todayKey);
    if (keyMismatch) {
      return skip('PRICING_KEY_CHANGED', oldShareCny, false, keyMismatch, basisCny);
    }
    const lines: Array<Record<string, unknown>> = [];
    let sum = 0;
    for (const leg of legs) {
      const rate = await getFlightSettlementRate(leg.flightNumber, leg.departDate, txClient);
      // 任一段无价 → 整单放弃（与录单同款：绝不做半单收敛）。
      if (!rate) {
        return skip(
          'NO_CALENDAR',
          oldShareCny,
          false,
          {
            note: '该航班当日结算价未维护',
            flightNumber: leg.flightNumber,
            departDate: leg.departDate,
          },
          basisCny,
        );
      }
      sum = round2(sum + rate.pricePerPersonCny);
      lines.push({
        flightNumber: leg.flightNumber,
        departDate: leg.departDate,
        pricePerPersonCny: rate.pricePerPersonCny,
      });
    }
    calendarSource = 'FLIGHT_SETTLEMENT_CALENDAR';
    // 机票日历没有立减这一维（立减规则的键是档次×晚数），这里原样接力基准那一位，
    // 只为让连续换人读到的 calendarDetail.discountApplied 恒有值、不至于第二次换人 fail-closed。
    // calendarKey 同样接力：下一次换人要能比出这之后有没有再改期。
    detail = { lines, discountApplied: basis.discountApplied, calendarKey: todayKey };
    newSettlementCny = toInt(sum);
  }

  if (newSettlementCny == null || !(newSettlementCny > 0)) {
    return skip('NO_CALENDAR', oldShareCny, false, { ...detail, note: '取价结果异常（≤0）' }, basisCny);
  }
  // 日历比日历：涨了多少 / 跌了多少，只跟基准比，不跟这个人的每人份额比。
  // 两端都已取整（basisCny 来自 resolveSwapRepriceBasis、newSettlementCny 见上方各分支），
  // 所以 delta / diff 天然是整数 —— diff 进 Order.adjustmentCny 这个 Int 列。
  const deltaCny = toInt(newSettlementCny - basisCny);
  if (Math.abs(deltaCny) > PRICE_ADJUSTMENT_CAP_CNY) {
    return skip('DIFF_OVER_CAP', oldShareCny, false, { ...detail, deltaCny }, basisCny);
  }
  return {
    basisCny,
    oldShareCny,
    newSettlementCny,
    diffCny: Math.max(0, toInt(basisCny - newSettlementCny)),
    calendarSource,
    settlementLocked: false,
    detail: { ...detail, basisCny, basisSource: basis.source },
  };
}

/**
 * 换人重算的**差价基准**：这张单成交那天的日历每人价（CNY，整数）。取不到 → basisCny=null + 原因。
 *
 * 取法三级（口径与「为什么是日历基准而不是每人份额」见 resolveSwapRepriceQuote 方法头）：
 *   0. 拆单拆出来的新单（splitsIn > 0）一律不认基准 —— 三级来源全部拦在最前面（M4 不变式：
 *      拆出来的新单不重算）。此前这道闸只挡在第 3 级门口，于是「换过人之后再被拆出去」的乘客
 *      带着他名下那条 SWAP_REPRICE 行进了新单，第 1 级照样接力、照样重算，把不变式绕了过去。
 *   1. PRIOR_SWAP —— 这位乘客名下已有 SWAP_REPRICE 行：取**最近**那一行的 newSettlementCny。
 *      连续换人必须接力，否则第二次换人会拿第一次换之前的价再减一遍，同一段日历差被收两次。
 *   2. CALENDAR_STAMP —— 整单 SETTLEMENT 行带 calendarPerPaxCny（2026-09 起建单落的基准戳）：
 *      基准 = calendarPerPaxCny − calendarDiscountPerPaxCny，逐分精确。
 *   3. LEGACY_AUDIT —— 存量单（无基准戳）：回建单那条 APPLY_SETTLEMENT_TOTAL 审计，
 *      把 after.settlementCalendar 这个 blob 原样喂给 resolveCalendarPerPaxBasis ——
 *      **每人价就写在 lines[].pricePerPersonCny 上**，与建单当场盖章同一份口径。
 *      blob 缺失 / 口径不明（多条套餐行分不清这人算哪一条、没有行、价 ≤0）→ NOT_CALENDAR_PRICED。
 *
 * 为什么**撤掉了**旧的 DERIVED_FROM_TOTAL（结算总价 ÷ 占座人数，复审 H1/H2 BLOCK）：
 * settlementTotalCny 是**含加项**的整单成交价 —— 单房差 / 升舱 / 婴儿价 / 儿童折扣 /
 * 指定酒店加价 / 自备签减免全在里面，除以人数得到的既不是日历价、还常常带小数：
 *   · 基准偏高 → 换人时被当成「日历跌价」，旧客白补一笔换人差价；
 *   · 自备签减免被摊进基准后，换人通道的 SWAP_VISA_DEDUCT_REVERSAL 会把同一笔减免再撤一次（双收）；
 *   · 带小数的 diff 直接写进 Order.adjustmentCny（Int 列）会让整个换人事务 500 回滚。
 * 审计 blob 里的每人价没有这些毛病，也不需要人数这个变量，所以婴儿那道闸一并撤掉。
 *
 * 三级都返回 discountApplied：「基准是不是已经减过代理立减」。换人当天要不要再减今天的立减，
 * 只看这一位（复审 H3）；判不出来就不重算，绝不猜。
 * 三级也都返回 key：「基准是日历上的哪一格」（档次×晚数×出发日 / 逐航段航班号×出发日）。
 * 改档 / 改期把这张单挪到了另一格之后，今昔两个价压根不是同一格的价，相减出来的不是
 * 「日历动了多少」而是改档 / 改期的价差（那笔钱各自的通道早就收过一次）。键读不出来 → 不重算。
 */
export async function resolveSwapRepriceBasis(
  svc: OrderService,
  db: Prisma.TransactionClient | typeof prisma,
  orderId: string,
  order: {
    passengers: ReadonlyArray<{ id: string }>;
    items: ReadonlyArray<{
      passengerId: string | null;
      metadata: Prisma.JsonValue | null;
      createdAt?: Date | null;
    }>;
    _count?: { splitsIn?: number; splitsOut?: number } | null;
  },
  passengerId: string,
): Promise<{
    basisCny: number | null;
    source: string | null;
    /** 基准里已经减过代理立减 → 换人当天也要减；false → 两边都不减（复审 H3）。 */
    discountApplied: boolean;
    /** 基准取自日历上的哪一格；换人当天先比这个键（见方法头）。取不到基准时为 null。 */
    key: SwapCalendarKey | null;
    note?: string;
  }> {
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  // 结算价日历本来就是整数每人价（SettlementRate.pricePerPersonCny 是 Int），
  // 这里再取一次整只为兜住脏数据：基准/新价/差额/差价全线整数，Order.adjustmentCny 是 Int 列。
  const toInt = (n: number): number => Math.round(n);
  const skip = (note: string) => ({
    basisCny: null,
    source: null,
    discountApplied: false,
    key: null,
    note,
  });

  // ── 0. 拆单拆出来的新单：三级来源一律不认（M4 不变式，闸必须在最前面）──────────
  // 结算价收敛行整条留在源单，所以子单通常本来就取不到基准；但**按人挂的调价行会随人搬家**，
  // 「换过人之后又被拆出去」的乘客带着他名下那条 SWAP_REPRICE 行进新单，第 1 级就会接力重算。
  // 闸摆在第 3 级门口挡不住这条路，所以提到最前面。
  if ((order._count?.splitsIn ?? 0) > 0) {
    return skip('本单是拆单拆出来的新单，拆前的日历基准与这张单对不上');
  }

  // ── 1. 上一次换人留下的基准（连续换人接力）───────────────────────────────
  const priorRows = order.items
    .filter(
      (it) =>
        it.passengerId === passengerId &&
        readJsonObject(it.metadata).reasonCode === 'SWAP_REPRICE',
    )
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
  const priorMeta = readJsonObject(priorRows.at(-1)?.metadata ?? null);
  const priorBasis = num(priorMeta.newSettlementCny);
  if (priorBasis != null && priorBasis > 0) {
    // 上一次换人减没减立减，随那一行的 calendarDetail 一起留了痕；读不到就不接力
    //（fail-closed：这一位判错的后果是同一笔立减被多减或多收一次）。
    const priorDetail = readJsonObject(
      (priorMeta.calendarDetail ?? null) as Prisma.JsonValue | null,
    );
    const priorApplied = priorDetail.discountApplied;
    if (typeof priorApplied !== 'boolean') {
      return skip('上一次换人的重算行未记录立减口径，判不出基准是否已减立减');
    }
    // 上一次换人取的是日历上的哪一格，同样随那一行留了痕；读不到就不接力
    //（fail-closed：判不出键，就分不清今天的价是「日历动了」还是「这单改过档/改过期」）。
    const priorKey = readCalendarKey(priorDetail.calendarKey);
    if (!priorKey) {
      return skip('上一次换人的重算行未记录定价键，判不出这单之后有没有改档/改期');
    }
    return {
      basisCny: toInt(priorBasis),
      source: 'PRIOR_SWAP',
      discountApplied: priorApplied,
      key: priorKey,
    };
  }

  // ── 2/3. SETTLEMENT 行：先找基准戳，没有再回建单审计 ───────────────────────
  const settlementRows = order.items.filter(
    (it) => readJsonObject(it.metadata).settlementPrice === true,
  );
  // 按人 SETTLEMENT 覆盖行在场 = 这单是逐人填的价，整单基准不代表这个人 → 不猜。
  if (settlementRows.some((it) => readJsonObject(it.metadata).perPassenger === true)) {
    return skip('本单按每人结算价成交，无整单日历基准');
  }
  const orderRow = settlementRows.find(
    (it) => readJsonObject(it.metadata).perPassenger !== true,
  );
  // 没有结算价收敛行 = 日历差额恰为 0（没落行）或压根不是结算价成交，也包括拆出来的新单
  //（SETTLEMENT 行整条留在源单，见 split-move-strategies 的 movePriceAdjustment）→ 一律不重算。
  if (!orderRow) {
    return skip('本单没有结算价收敛行，判不出日历基准');
  }
  const meta = readJsonObject(orderRow.metadata);
  const stamped = num(meta.calendarPerPaxCny);
  if (stamped != null && stamped > 0) {
    const discountPerPax = num(meta.calendarDiscountPerPaxCny) ?? 0;
    const basisCny = toInt(stamped - discountPerPax);
    if (!(basisCny > 0)) return skip('基准戳异常（≤0）');
    // 定价键与基准戳同批盖章（buildSettlementTotalItem）。没有键 = 判不出这单成交之后
    // 有没有改档 / 改期 —— 那就没法保证今昔两个价是同一格的价，一律不重算（fail-closed）。
    const stampedKey = readCalendarKey(meta.calendarKey);
    if (!stampedKey) {
      return skip('基准戳未记录定价键（档次/晚数/出发日），判不出这单之后有没有改档/改期');
    }
    // calendarDiscountApplied 是与基准戳同批盖的章；万一只有老版本的两个键（本批之前的
    // 灰度行），退回「减过的金额 > 0 就算减过」这个可判的近似，仍不猜「减了 ¥0」这种情形。
    const appliedFlag = meta.calendarDiscountApplied;
    return {
      basisCny,
      source: 'CALENDAR_STAMP',
      discountApplied: typeof appliedFlag === 'boolean' ? appliedFlag : discountPerPax > 0,
      key: stampedKey,
    };
  }

  // ── 3. 存量单：回建单审计里的日历 blob 取每人价（不再 ÷ 人数，见方法头）──────
  // 拆出去过的源单（splitsOut > 0）也不认这份 blob：它记的是拆之前那张单的产品构成，
  // 与现在这张单未必还对得上。（拆出来的新单 splitsIn > 0 已在本方法最前面全线拦掉。）
  if ((order._count?.splitsOut ?? 0) > 0) {
    return skip('本单拆过单，建单日历快照与当前订单构成已对不上');
  }
  const calendarAudit = await readOrderSettlementCalendarAudit(db, orderId);
  if (!calendarAudit) {
    return skip('本单不是结算价日历成交（手工价/议价）');
  }
  // 建单只在**真减了立减**时才把 autoDiscount 写进这个 blob（见 createOrder 的组装段），
  // 因此这个键在不在，就等于「当时减没减」——手工价通道压根不会命中立减，也就不会有这个键。
  const auditDiscount = (calendarAudit.autoDiscount ?? null) as AutoDiscountSummary | null;
  const derived = resolveCalendarPerPaxBasis(calendarAudit, auditDiscount);
  if (!derived) {
    return skip('建单日历快照口径不明（多条套餐行 / 无每人价），判不出日历基准');
  }
  const basisCny = toInt(derived.perPaxCny - derived.discountPerPaxCny);
  if (!(basisCny > 0)) return skip('建单日历快照的每人价异常（≤0）');
  return {
    basisCny,
    source: 'LEGACY_AUDIT',
    discountApplied: derived.discountApplied,
    // 定价键直接来自建单审计的 lines（档次/晚数/出发日 或 逐航段航班号/出发日）。
    key: derived.key,
  };
}

/**
 * 换人预览（GET /orders/:id/passengers/:passengerId/swap-preview · ADMIN/STAFF + 代理自家单）。
 *
 * 只读：换人弹窗打开时先告诉经办人「这个人现在算多少钱、按今天的日历重算是多少、旧客要补多少差价、
 * 换人费有哪几档」。与真换人跑同一份取价内核（resolveSwapRepriceQuote），预览所见 = 换人所得。
 */
export async function swapPreview(
  svc: OrderService,
  orderId: string,
  passengerId: string,
  actor: { userId: string; role: UserRole; agentId?: string },
): Promise<{
    /** 差价基准 = 成交那天的日历每人价；null = 判不出（此时 repriceSkipped 必有值）。 */
    basisCny: number | null;
    oldShareCny: number;
    newSettlementCny: number | null;
    diffCny: number;
    calendarSource: string | null;
    settlementLocked: boolean;
    repriceSkipped?: SwapRepriceSkipReason;
    feeOptions: number[];
  }> {
  const isInternalActor = actor.role === UserRole.ADMIN || actor.role === UserRole.STAFF;
  if (!isInternalActor) {
    if (!actorCan(actor, 'orders.passengers.swap')) {
      throw new ForbiddenError('仅运营/代理可查看换人预览');
    }
    // 归属闸与换人同一口径（代理只能看自己 + 下级代理的单）。
    await svc.assertPassengerEditScope(orderId, actor);
  }
  // ── 有效订单守卫：与真换人同一对闸、同一句话（复审 L5）────────────────────
  // 预览是换人弹窗打开时跑的第一步。若这里不判，回收站单 / 已取消 / 已退款单照样能弹出
  //「新价 800，旧客补 200」这样一份报价，经办人照着填完点确认才被写入口拒掉 ——
  // 白填一遍不说，更糟的是他会以为「这单本来就该这么算」。让预览当场说同一句话。
  const orderGuard = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true, deletedAt: true },
  });
  if (!orderGuard) throw new NotFoundError('订单不存在');
  if (orderGuard.deletedAt) {
    throw new BadRequestError('订单在回收站（已软删），不可换人；如需操作请先恢复');
  }
  if (!SEAT_HOLDING_STATUSES.includes(orderGuard.status)) {
    throw new BadRequestError(
      `订单当前状态（${zhStatus(orderGuard.status)}）不可换人：仅占座中的有效订单可换人（已取消/已退款/超时订单请勿换人）`,
    );
  }
  const passenger = await prisma.passenger.findUnique({
    where: { id: passengerId },
    select: { id: true, orderId: true },
  });
  if (!passenger || passenger.orderId !== orderId) {
    throw new NotFoundError('出行人不存在或不属于该订单');
  }
  const quote = await svc.resolveSwapRepriceQuote(prisma, orderId, passengerId);
  const feeOptions = await getSwapFeeOptions(prisma);
  return {
    basisCny: quote.basisCny,
    oldShareCny: quote.oldShareCny,
    newSettlementCny: quote.newSettlementCny,
    diffCny: quote.diffCny,
    calendarSource: quote.calendarSource,
    settlementLocked: quote.settlementLocked,
    ...(quote.repriceSkipped ? { repriceSkipped: quote.repriceSkipped } : {}),
    feeOptions,
  };
}

/**
 * 代理动别人家的单 → 403（换人 / 订正共用的归属闸）。
 *
 * 与 getOrder / 补录同一口径（assertCanView：代理只能碰自己 + 下级代理的单）。
 * 刻意放在事务外、只读一次归属：这是权限判定，不参与后续读-改-写的并发串行。
 */
export async function assertPassengerEditScope(
  svc: OrderService,
  orderId: string,
  actor: { userId: string; role: UserRole; agentId?: string },
): Promise<void> {
  const owner = await prisma.order.findUnique({
    where: { id: orderId },
    select: { userId: true, agentId: true },
  });
  if (!owner) throw new NotFoundError('订单不存在');
  await svc.assertCanView(owner, {
    userId: actor.userId,
    role: actor.role,
    agentId: actor.agentId,
  });
}

/**
 * 代理自助改单闸（航班纠错 / 订单级签证状态 / 换酒店 / 升舱 四条通道共用）。
 *
 *   · ADMIN/STAFF：直接放行 —— 运营本来就随时能改，这道闸只是给代理开的口子。
 *   · CUSTOMER：403。自助改单是代理与我方之间的业务口径，客户侧没有这条通道。
 *   · AGENT：先过归属（assertCanView：只能碰自己 + 下级代理的单），再过下单当天窗口
 *     （computeAgentSelfEditWindow），关闭则把窗口自己的 reason 原样抛给界面 ——
 *     报错文案和详情页上那行提示是同一句，代理不会看到两种说法。
 *
 * 刻意只读一次、放在事务外：这是权限判定，不参与后续读-改-写的并发串行；
 * 真正的资金/座位安全由各通道自己的 Order 行锁负责。窗口边界（23:59:59 提交、
 * 00:00:01 才落库）不做额外收紧 —— 差一秒的单本来就该让代理改完，运营次日照样复核。
 */
export async function assertAgentSelfEditAllowed(
  svc: OrderService,
  orderId: string,
  actor: { userId: string; role: UserRole; agentId?: string },
): Promise<void> {
  if (actor.role === UserRole.ADMIN || actor.role === UserRole.STAFF) return;
  if (actor.role !== UserRole.AGENT) {
    throw new ForbiddenError('仅运营 / 代理可自助改单');
  }
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      userId: true,
      agentId: true,
      createdAt: true,
      status: true,
      deletedAt: true,
      outboundInvoiced: true,
      returnInvoiced: true,
      systemInvoiced: true,
      settlementLocked: true,
    },
  });
  if (!order) throw new NotFoundError('订单不存在');
  await svc.assertCanView(order, {
    userId: actor.userId,
    role: actor.role,
    agentId: actor.agentId,
  });
  const window = computeAgentSelfEditWindow(order);
  if (!window.open) {
    throw new ForbiddenError(window.reason ?? AGENT_SELF_EDIT_REASON.NEXT_DAY);
  }
}

/**
 * 写订单级签证状态（原先内联在 PATCH /orders/:id/notes 里，抽出来给自助 / 改单申请共用）。
 *
 * 三件事一个都没变，运营侧行为与抽出前逐字一致：
 *   ① 矛盾组合硬闸：改成「需要签证 / 电子签」但已录出行人全是自备签 → 400。这种组合
 *      不会生成签证任务（orderNeedsVisaTask 一票否决），签证台看不见这单 → 漏送签。
 *      豁免未录出行人（先建单后补人是正常流程）与取消族 / 回收站单（不参与履约）。
 *   ② 状态真变了才跑签证任务同步，且放在事务里 —— 同步内部是「读现状 → 撤 / 建」，
 *      裸用全局 prisma 时两个并发请求会各建一条任务。
 *   ③ 审计仍由调用方（路由）写，before/after 由本方法返回，口径不分叉。
 *
 * options：
 *   · noteData —— 与签证状态**同一条 UPDATE、同一个事务**落库的备注列（notes 路由传）。
 *     抽出本方法时曾变成「先写签证状态，再由路由写备注」两次写：中间失败就留下
 *     「签证状态改了、备注没改」的半拉现场，而这两栏在界面上是同一次提交。收回一处写。
 *   · withOrder —— 是否回读并序列化整单（默认 true）。notes 路由只回 `{ ok: true }`，
 *     为它拼一次 ORDER_FULL_INCLUDE 的富联查纯属白花钱，传 false 直接省掉。
 *
 * 权限**不在这里判**：调用方按自己的通道判（运营走 notes 路由的 opsOnly 闸；代理走
 * assertAgentSelfEditAllowed + HAS_VISA 硬拦）。本方法只保证「写进去的状态是自洽的」。
 */
export async function setOrderVisaStatus(
  svc: OrderService,
  orderId: string,
  visaStatus: VisaRequirement,
  actor: { userId: string; role: UserRole; agentId?: string },
  options: { withOrder?: boolean; noteData?: Prisma.OrderUpdateInput } = {},
): Promise<{
    order: ReturnType<typeof serializeOrder> | null;
    changed: boolean;
    before: VisaRequirement | null;
    after: VisaRequirement;
  }> {
  const current = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      visaStatus: true,
      status: true,
      deletedAt: true,
      passengers: { select: { visaExempt: true } },
    },
  });
  if (!current) throw new NotFoundError('订单不存在');

  const orderInactive =
    Boolean(current.deletedAt) || FULFILLMENT_TERMINATING_STATUSES.includes(current.status);
  if (!orderInactive) {
    assertNoVisaContradiction({ visaStatus, passengers: current.passengers });
  }

  // 订单级声明走状态机转移表（DECLARE_*）：changed = 档位真变了才跑任务同步。
  // 订单级事件不看乘客列，事实只需订单头；allPassengersExempt 只影响派生态文案，不影响写入。
  const declaration = transitionPassengerVisa(
    {
      orderVisaStatus: current.visaStatus,
      visaExempt: false,
      visaSubmissionStatus: null,
      allPassengersExempt: false,
    },
    orderVisaDeclarationEvent(visaStatus),
  );
  const changed = declaration.ok && declaration.changed;
  // 签证状态 + 备注四栏 + 签证任务同步，一个事务落地：要么都生效，要么一个字都不落。
  // 备注四栏与签证状态是同一次提交 → 即便档位没变也要落这一条 UPDATE（noteData 要写）。
  await prisma.$transaction(async (tx) => {
    await writeOrderVisaStatus(tx, orderId, visaStatus, options.noteData);
    if (changed) {
      await syncVisaTasksForOrder(tx, orderId, { userId: actor.userId, role: actor.role });
    }
  });

  if (options.withOrder === false) {
    return { order: null, changed, before: current.visaStatus, after: visaStatus };
  }
  const finalOrder = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: ORDER_FULL_INCLUDE,
  });
  return {
    order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
    changed,
    before: current.visaStatus,
    after: visaStatus,
  };
}

/**
 * 订正出行人证件资料（同一个人录错了字，不是换人）。
 *
 * 与 swapPassenger 的根本区别 —— **只写传进来的字段，一个字段都不清空**：
 * 护照图 / 签发地 / 签发国 / 出生地 / 签证号与签证日期 / 票号 / 乘客级选项一律原样保留。
 * 人没变，这些资料本来就是他的；换人通道那套「随人走的清洗」在这里全部不适用。
 * 实测里九月上旬十几条「换人」记录，绝大多数其实是护照 OCR 把一个字符读错后的订正
 * （Q 被读成 0 / 5），走换人通道把护照图全清了 —— 本方法就是为堵这个洞而设。
 *
 * 六道闸（依序，全部在同一个事务 + Order 行锁 FOR UPDATE 之下）：
 *   ① 归属：ADMIN/STAFF 全量；代理只能订正自家（含下级）单 → 否则 403。
 *   ② 订单状态：代理按补录口径（PENDING_PAYMENT/PAID/PROCESSING，否则 409 ORDER_LOCKED）、
 *      运营按换人口径（占座态，否则 400）。死单/回收站单上改身份没有任何正当场景。
 *   ③ 证件号改动幅度：与原值（trim + 大写后）的编辑距离 > 2 就不是「录错字」而是换了个人
 *      → 400 指路换人。原值为空（占位单还没录证件）时不比距离 —— 那是补录，走的是
 *      「从空补成真值」的口径，与补录通道同样只跑一次同班次反向查重。
 *   ④ 证件号与姓名同时改动（姓名编辑距离 > 2）→ 400：连号护照 + 全新姓名是换人伪装成订正。
 *      只改姓名不动证件号照旧放行（同一本护照就是同一个人）。
 *   ⑤ 代理改已订座/已出票的人的姓名/证件号 → 400：票面身份已进航司系统，值机会对不上。
 *   ⑥ 已开票的单改姓名/证件号 → 400：票面身份已经发出去了，必须走换人并显式重置开票位。
 *      中文姓名不在⑤⑥之列（护照扩展字段，不上票面）。
 * 查重两道：同一订单内不许出现两位相同证件号的出行人；订正后的护照也不许在同班次的
 * 其他有效订单里已经占着座（与补录通道同一道反向查重，同事务内跑）。
 * 生日改动仍按建单同款权威口径重派生 passengerType（与换人 1b2 同一段逻辑），
 * 否则把生日从 2019 改成 2009 之后，乘客还挂着「婴儿」类型进出票与分房。
 */
export async function correctPassenger(
  svc: OrderService,
  orderId: string,
  passengerId: string,
  input: {
    lastName?: string;
    firstName?: string;
    fullName?: string;
    chineseName?: string;
    documentNumber?: string;
    dateOfBirth?: string;
    gender?: import('@prisma/client').Gender;
    nationality?: string;
    passportExpiry?: string;
    passportIssueDate?: string;
  },
  requester: OrderRequester,
): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      passengerId: string;
      before: Record<string, string | null>;
      after: Record<string, string | null>;
      changedFields: string[];
    };
  }> {
  // 整段读-判-写包在一个事务里，开头对 Order 行 FOR UPDATE（与换人 / 改自备签同一把锁）：
  // 订正要按「订单状态 + 开票位 + 同单/同班次证件号」判完再写，裸读会与并发出票流转、
  // 并发换人/订正 TOCTOU —— 两个请求各自读到「没人用这本护照」，然后各写各的。
  const scratch = await prisma.$transaction(async (tx) => {
    const orderRows = await tx.$queryRaw<
      Array<{
        id: string;
        orderNumber: string;
        userId: string | null;
        agentId: string | null;
        status: OrderStatus;
        deletedAt: Date | null;
        outboundInvoiced: boolean | null;
        returnInvoiced: boolean | null;
        systemInvoiced: boolean | null;
      }>
    >`SELECT id, "orderNumber", "userId", "agentId", status, "deletedAt", "outboundInvoiced", "returnInvoiced", "systemInvoiced" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const order = orderRows[0];
    if (!order) throw new NotFoundError('订单不存在');
    // 闸①：归属（ADMIN/STAFF 直接放行；代理限自己 + 下级；客户到不了这条路径）
    await svc.assertCanView(order, requester);
    if (order.deletedAt) {
      throw new BadRequestError('订单在回收站（已软删），不可订正出行人资料；如需操作请先恢复');
    }

    // ── 闸②：订单状态 ──────────────────────────────────────────────────
    // 此前这条通道**一道状态闸都没有**：已取消 / 已退款 / 支付超时的死单上照样能改身份，
    // 而补录（selfUpdatePassenger）与换人（swapPassenger）两条兄弟通道都拦着。
    //   · 代理：按补录同一口径（出票流程启动前可改），出票后一律 409 走客服；
    //   · 运营：按换人同一口径（占座态才算有效订单），死单/回收站单不许再改身份。
    const isInternalActor =
      requester.role === UserRole.ADMIN || requester.role === UserRole.STAFF;
    if (!isInternalActor) {
      if (!SELF_EDITABLE_PASSENGER_STATUSES.includes(order.status)) {
        throw new AppError('当前订单状态不可修改出行人资料，请联系客服', {
          statusCode: 409,
          code: 'ORDER_LOCKED',
        });
      }
    } else if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
      throw new BadRequestError(
        `订单当前状态（${zhStatus(order.status)}）不可订正出行人资料：仅占座中的有效订单可订正（已取消/已退款/超时订单请勿订正）`,
      );
    }

    const passenger = await tx.passenger.findUnique({
      where: { id: passengerId },
      select: {
        id: true,
        orderId: true,
        fullName: true,
        lastName: true,
        firstName: true,
        chineseName: true,
        documentNumber: true,
        dateOfBirth: true,
        gender: true,
        nationality: true,
        passengerType: true,
        passportExpiry: true,
        passportIssueDate: true,
        // 票务现势：代理订正闸要读（已订座/已出票的人不给代理改票面身份）。
        pnr: true,
        eticketNumber: true,
      },
    });
    if (!passenger || passenger.orderId !== orderId) {
      throw new NotFoundError('出行人不存在或不属于该订单');
    }

    // ── 闸③：证件号改动幅度 ──────────────────────────────────────────────
    // 证件号统一按「trim + 大写」规范化后再比、再写：同一本护照录成小写不算改动，
    // 也就不该白写一次库、更不该在审计里留一条「变了」。
    // （建单入口不做这层规范化，是历史存量口径；这里只规范本次订正写进去的值。）
    const oldDocument = normalizeDocumentNumber(passenger.documentNumber);
    const nextDocument =
      input.documentNumber !== undefined
        ? normalizeDocumentNumber(input.documentNumber)
        : undefined;
    const documentChanging =
      nextDocument !== undefined && nextDocument !== '' && nextDocument !== oldDocument;
    // 原值为空（占位单还没录证件）不比距离 —— 那是「从空补成真值」的补录，不是订正，
    // 比距离必然超阈值，会给出「请使用换人」这种误导性指路。
    if (documentChanging && oldDocument !== '') {
      // 只关心是否超阈值，故给早停上限（两侧都已大写，距离本身与大小写无关）。
      const distance = levenshteinDistance(oldDocument, nextDocument, TYPO_MAX_EDIT_DISTANCE);
      if (distance > TYPO_MAX_EDIT_DISTANCE) {
        throw new BadRequestError(
          `证件号改动超过 ${TYPO_MAX_EDIT_DISTANCE} 个字符，请使用「换人」`,
        );
      }
    }

    // ── 闸④：证件号与姓名同时改动 = 换人伪装成订正 ─────────────────────────
    // 单看证件号那道闸只量「差几个字符」，于是「连号护照 + 一个全新的名字」能整条溜过去：
    // E1234567 → E1234568 距离 1，姓名 ZHANG/SAN → LI/SI 一起改掉 —— 这是另一个人上飞机，
    // 却按订正走：护照图/签证号/票号全部原样留着挂到新名字下面，签证台与值机全被误导。
    // 判定：证件号真的变了 **且** 规范化后的姓名编辑距离 > 2 才拦。
    //   · 只改名字不动证件号 → 放行：同一本护照就是同一个人，OCR 把 SAN 读成 SAM 是常事。
    //   · 名字只差一两个字符（错字）+ 证件号错字 → 放行：一次录单两处笔误是常态。
    const oldName = normalizeCorrectionName(passenger.fullName, passenger.lastName, passenger.firstName);
    const nextName =
      input.fullName !== undefined
        ? normalizeCorrectionName(input.fullName, null, null)
        : input.lastName !== undefined || input.firstName !== undefined
          ? normalizeCorrectionName(
              null,
              input.lastName ?? passenger.lastName,
              input.firstName ?? passenger.firstName,
            )
          : null;
    if (documentChanging && nextName !== null && nextName !== oldName) {
      const nameDistance = levenshteinDistance(oldName, nextName, TYPO_MAX_EDIT_DISTANCE);
      if (nameDistance > TYPO_MAX_EDIT_DISTANCE) {
        throw new BadRequestError('证件号与姓名同时改动，请使用「换人」');
      }
    }

    const nameChanging =
      (input.fullName !== undefined && input.fullName !== passenger.fullName) ||
      (input.lastName !== undefined && input.lastName !== (passenger.lastName ?? undefined)) ||
      (input.firstName !== undefined && input.firstName !== (passenger.firstName ?? undefined));

    // ── 闸④b：只改姓名也有幅度上限（非内部角色）───────────────────────────
    // 闸④只在「证件号也变了」时才量姓名，于是「证件号一个字不动、姓名整个换掉」是条敞开的路：
    // 同一本护照挂上另一个人的名字照样是换人，出票与值机对的是姓名 + 证件号那一对。
    // 阈值放宽到 3（比证件号的 2 松）：中英文姓名的正常订正（漏一个音节、姓名颠倒一个字）
    // 常常差三个字符，真正的换人差的远不止 3。运营/管理员不受此限（他们本就在核对现场）。
    if (
      !isInternalActor &&
      !documentChanging &&
      nextName !== null &&
      nextName !== oldName &&
      levenshteinDistance(oldName, nextName, CORRECTION_NAME_MAX_EDIT_DISTANCE) >
        CORRECTION_NAME_MAX_EDIT_DISTANCE
    ) {
      throw new BadRequestError('姓名改动较大，请使用「换人」');
    }

    // ── 闸④c：分两步的伪装换人（非内部角色）───────────────────────────────
    // 闸④只看**单次**请求：先提一次「只改姓名」（过闸④b 的小步），再提一次「只改证件号」
    // （过闸③的小步），两次合起来就是一个全新的人，而每一次单看都像正常订正。
    // 所以要看这位出行人的订正历史：此前订正过姓名、这次动证件号（或者反过来）→ 一律指路换人。
    // 历史取自审计（CORRECT_ORDER_PASSENGER 的 before.passengerId 就是这一位），
    // 与界面上「订正历史」读的是同一份流水，运营复核时看到的和闸判的是同一件事。
    if (!isInternalActor && (nameChanging || documentChanging)) {
      const priorCorrections = await tx.auditLog.findMany({
        where: {
          action: 'CORRECT_ORDER_PASSENGER',
          before: { path: ['passengerId'], equals: passengerId },
        },
        select: { before: true, after: true },
      });
      const priorFields = new Set<string>();
      for (const row of priorCorrections) {
        // 优先读 after.changedFields（路由写审计时就落了这一份）；老记录回退到 before 的键。
        const changedFields = readJsonObject(row.after).changedFields;
        const fields = Array.isArray(changedFields)
          ? changedFields
          : Object.keys(readJsonObject(row.before)).filter((k) => k !== 'passengerId');
        for (const field of fields) {
          if (typeof field === 'string') priorFields.add(field);
        }
      }
      const priorNameCorrected = CORRECTION_NAME_FIELDS.some((f) => priorFields.has(f));
      const priorDocumentCorrected = priorFields.has('documentNumber');
      if (
        (priorNameCorrected && documentChanging) ||
        (priorDocumentCorrected && nameChanging)
      ) {
        throw new BadRequestError('该出行人此前已订正过姓名/证件号，再次改动请使用「换人」');
      }
    }

    // ── 闸⑤：代理不许改已订座/已出票的人的票面身份 ─────────────────────────
    // 与换人通道同一口径：开票位是财务口径（发票开没开），票务口径要另看 —— 订单状态已出票/
    // 已完成，或这一位身上已经有 PNR / 电子票号。改了票面身份，航司那边对不上，值机卡死。
    // （状态那半其实已被闸②的代理分支挡住，这里显式再写一次：两道闸各自成立，日后谁放宽
    //   闸②也不会连带把这条口子一起放开。）中文姓名不在此列（护照扩展字段，不上票面）。
    if (!isInternalActor && (nameChanging || documentChanging)) {
      const ticketed =
        order.status === OrderStatus.TICKETED ||
        order.status === OrderStatus.COMPLETED ||
        (passenger.pnr ?? '').trim() !== '' ||
        (passenger.eticketNumber ?? '').trim() !== '';
      if (ticketed) {
        throw new BadRequestError('已订座/已出票，改姓名/证件号请联系运营');
      }
    }

    // ── 闸⑥：已开票的单不许改票面身份 ────────────────────────────────────
    // 排在查重之前：这是纯内存判定，不该为一个注定要拒的请求先去数据库跑一趟同班次查重。
    const invoiced =
      order.outboundInvoiced === true ||
      order.returnInvoiced === true ||
      order.systemInvoiced === true;
    if (invoiced && (nameChanging || documentChanging)) {
      throw new BadRequestError('已出票，改姓名/证件号请走「换人」并勾选重置开票');
    }

    if (documentChanging) {
      // 同一订单内查重：反向查重只看**别的订单**，同单里两位出行人被订正成同一本护照
      // （典型是同行家属的资料串行录错）它一句话都不说，出票时才炸。
      // 大小写不敏感：证件号在订正通道统一大写后落库，但存量/建单入口没做这层规范化，
      // 库里躺着 `e12345678` 这种小写值 —— 按字面比对会漏判，同单里就真出现两位同一本护照。
      const sameOrderDup = await tx.passenger.findFirst({
        where: {
          orderId,
          id: { not: passengerId },
          documentNumber: { equals: nextDocument, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (sameOrderDup) {
        throw new BadRequestError('同一订单内已有相同证件号的出行人');
      }
      // 与补录通道同一道反向查重：订正后的这本护照若已在同班次的有效订单里占着座，
      // 同一个人就在同一班次上占了两份 —— 必须先处理掉其中一张单。
      await svc.assertBackfilledDocumentNotDuplicated(orderId, nextDocument, tx);
    }

    // ── 写入：只映射传进来的字段（与补录同款「undefined 即不动」；这里绝不出现任何置 null）──
    const data: Prisma.PassengerUpdateInput = {};
    if (input.fullName !== undefined) {
      data.fullName = input.fullName;
      // 客户端没显式给 lastName/firstName 时按下单口径自动拆（与换人/建单同一函数）
      if (input.lastName === undefined || input.firstName === undefined) {
        const { lastName: autoLast, firstName: autoFirst } = splitPassengerFullName(
          input.fullName,
        );
        if (input.lastName === undefined && autoLast) data.lastName = autoLast;
        if (input.firstName === undefined && autoFirst) data.firstName = autoFirst;
      }
    }
    if (input.lastName !== undefined) data.lastName = input.lastName;
    if (input.firstName !== undefined) data.firstName = input.firstName;
    if (input.chineseName !== undefined) data.chineseName = input.chineseName;
    // 只在规范化后真的变了时才写：纯大小写差异 = 同一本护照，不落库也不进审计。
    if (documentChanging) data.documentNumber = nextDocument;
    if (input.dateOfBirth !== undefined) data.dateOfBirth = new Date(input.dateOfBirth);
    if (input.gender !== undefined) data.gender = input.gender;
    if (input.nationality !== undefined) data.nationality = input.nationality;
    if (input.passportExpiry !== undefined) data.passportExpiry = new Date(input.passportExpiry);
    if (input.passportIssueDate !== undefined) {
      data.passportIssueDate = new Date(input.passportIssueDate);
    }

    // 出行人类型服务端权威重派生 —— 与换人 1b2 同一口径（建单 passengerToData 也走它）。
    // 回退口径：已有的旧类型 > 兜底成人（同一人只是订正生日，不该把儿童/婴儿丢回成人）。
    if (data.dateOfBirth instanceof Date) {
      const flightItems = await tx.orderItem.findMany({
        where: { orderId, kind: OrderItemKind.FLIGHT, flightScheduleId: { not: null } },
        select: { flightSchedule: { select: { departureTime: true } } },
      });
      const departureDate = earliestFlightDeparture(
        flightItems.map((it) => ({ kind: 'FLIGHT', flightSchedule: it.flightSchedule })),
      );
      if (departureDate) {
        data.passengerType = ptcToPassengerType(
          derivePtcByAge(
            data.dateOfBirth,
            departureDate,
            passenger.passengerType ?? PassengerType.ADULT,
          ),
        );
      }
    }

    const updated = await tx.passenger.update({ where: { id: passengerId }, data });

    // 审计 before/after：只记**真的变了**的身份字段（PII 口径与换人审计一致——
    // 换人审计本就落姓名与证件号，订正不比它更敏感）。
    const before: Record<string, string | null> = {};
    const after: Record<string, string | null> = {};
    const changedFields: string[] = [];
    // 日期按 UTC 切片（同 buildSwapBeforeSnapshot 口径）：这些是「日期本身」，折时区会推后一天。
    const asText = (v: unknown): string | null =>
      v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    for (const field of CORRECTABLE_IDENTITY_FIELDS) {
      const oldValue = asText((passenger as Record<string, unknown>)[field]);
      const newValue = asText((updated as unknown as Record<string, unknown>)[field]);
      if (oldValue === newValue) continue;
      before[field] = oldValue;
      after[field] = newValue;
      changedFields.push(field);
    }
    return { before, after, changedFields };
  });
  const { before, after, changedFields } = scratch;

  const finalOrder = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: ORDER_FULL_INCLUDE,
  });
  return {
    // 与换人同款按角色脱敏（代理拿不到内部字段）
    order: serializeOrder(finalOrder, orderSerializeRoleCtx(requester.role)),
    audit: {
      orderNumber: finalOrder.orderNumber,
      passengerId,
      before,
      after,
      changedFields,
    },
  };
}

/**
 * 建单后按人改自备签（专用端点，不复用换人通道）。
 *
 * 为什么不走换人通道：swapPassenger 的 visaExempt 透传语义有洞——false→true 不减钱、
 * true→false 走 SWAP_VISA_DEDUCT_REVERSAL 调整行且按乘客一次性幂等（反复切换会少收）、
 * BUNDLE 行 metadata.addOns 快照永不更新（套餐改档读快照会算错差额）、不碰送签进度、
 * 审计记成换人。本方法把「同一个人改办签方式」做成对称、可逆、快照同步的专用动作：
 *
 *   · 钱**不走调整行**，走「行重算」：对唯一含自备签减免的 BUNDLE 行，以翻转后的乘客现势
 *     重算 addOns breakdown 与行金额 —— 其余维度（晚数/间数/单住/升舱/儿童婴儿）一律沿用
 *     原快照口径，绝不重读现价配置；总额变化必须恰等于 ±selfVisaDeductCny（建单快照费率）×1，
 *     对不上即抛错回滚（fail-closed，交人工走调价通道）。
 *   · 两个方向都把该乘客 visaSubmissionStatus 置回 PENDING（true→false 防旧 CONFIRMED 复活
 *     污染任务派生；false→true 本就应为 PENDING，写了幂等）。
 *   · 任务联动：syncVisaTasksForOrder 对齐任务的有无，再按「按人送签」口径重派生任务状态
 *     （仅动 PENDING/IN_PROGRESS；CONFIRMED/FAILED/CANCELLED 不碰）。
 *
 * 守卫（依序）：占座态 + 未软删 → 幂等短路 → false→true 需送签进度仍为 PENDING（已在办理
 * 则批文成本已发生）→ 换人通道补过钱的乘客拒绝（防两套钱法叠加双计）→ 有钱语义时
 * 结算锁 / 开票闸 / 多条钱行拒绝。非 BUNDLE 单（纯机票/签证单等）纯改标记，不动钱。
 */
export async function setPassengerVisaExempt(
  svc: OrderService,
  orderId: string,
  passengerId: string,
  input: {
    visaExempt: boolean;
    note?: string;
    /** 送签已在办理时的人为确认：退多少（0=不退）+ 原因。见 orders.schemas 同名字段注释。 */
    submittedOverride?: { refundCny: number; reason: string };
  },
  actor: { userId: string; role: UserRole },
): Promise<{
    order: ReturnType<typeof serializeOrder>;
    warning: string | null;
    /** 幂等短路（目标值与现值相同）：不写审计、不动钱。 */
    idempotent: boolean;
    /** 幂等短路时为 null（路由层据此跳过审计）。 */
    audit: {
      orderNumber: string;
      passengerId: string;
      before: { visaExempt: boolean; visaSubmissionStatus: string };
      after: { visaExempt: boolean; visaSubmissionStatus: string };
      /** 本次应收变化（CNY；非 BUNDLE 单恒 0）。 */
      totalDeltaCny: number;
      /** 已送签人为确认路径：实退客人金额（其余路径 null）。 */
      refundCny: number | null;
      /** 已送签人为确认路径：批文成本留存金额（其余路径 0）。 */
      retainCny: number;
    } | null;
  }> {
  if (!actorCan(actor, 'orders.passengers.write')) {
    throw new ForbiddenError('仅运营/管理员可改乘客自备签');
  }

  const scratch = await prisma.$transaction(async (tx) => {
    // Order 行锁（与换人/改结算价同一把 FOR UPDATE）：翻转要读-改-写 BUNDLE 行金额与
    // subtotal/total，无锁会与并发改价/换人 lost-update。
    const orderRows = await tx.$queryRaw<
      Array<{
        id: string;
        orderNumber: string;
        status: OrderStatus;
        deletedAt: Date | null;
        adjustments: Prisma.JsonValue;
        adjustmentCny: number;
        settlementLocked: boolean;
        outboundInvoiced: boolean;
        returnInvoiced: boolean;
        systemInvoiced: boolean;
        // 订单级签证状态：矛盾组合硬闸要读（见下方「2b」）。
        visaStatus: VisaRequirement | null;
      }>
    >`SELECT id, "orderNumber", status, "deletedAt", adjustments, "adjustmentCny", "settlementLocked", "outboundInvoiced", "returnInvoiced", "systemInvoiced", "visaStatus" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const order = orderRows[0];
    if (!order) throw new NotFoundError('订单不存在');

    // ── 1. 有效订单守卫（与换人同款双闸）──────────────────────────────
    if (order.deletedAt) {
      throw new BadRequestError('订单在回收站（已软删），不可改自备签；如需操作请先恢复');
    }
    if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
      throw new BadRequestError(
        `订单当前状态（${zhStatus(order.status)}）不可改自备签：仅占座中的有效订单可改（已取消/已退款/超时订单请勿改）`,
      );
    }

    const passenger = await tx.passenger.findUnique({
      where: { id: passengerId },
      select: {
        id: true,
        orderId: true,
        visaExempt: true,
        visaSubmissionStatus: true,
      },
    });
    if (!passenger || passenger.orderId !== orderId) {
      throw new NotFoundError('出行人不存在或不属于该订单');
    }

    // ── 2. 幂等短路：目标值与现值相同 → no-op（不写审计不动钱）──────────
    if (passenger.visaExempt === input.visaExempt) {
      return { noop: true as const };
    }
    const before = {
      visaExempt: passenger.visaExempt,
      visaSubmissionStatus: passenger.visaSubmissionStatus as string,
    };

    // ── 2b. 签证矛盾组合硬闸：把最后一位随团办签的人也改成自备签 ─────────────
    // 订单级仍是「需要签证 / 电子签」时，这一改会让本单再没有人要我方送签 →
    // 签证任务被撤（syncVisaTasksForOrder 按 orderNeedsVisaTask 判 false），签证台看不见这单。
    // 只拒绝、不替客人改任何标记（visaExempt 同时是定价输入，服务端翻它 = 静默改价）。
    // 已在上方拦掉取消族终态与回收站单，故此处无需再判「不参与履约」。
    if (input.visaExempt && orderVisaStatusRequiresVisa(order.visaStatus)) {
      const roster = await tx.passenger.findMany({
        where: { orderId },
        select: { id: true, visaExempt: true },
      });
      // 以「本次翻转已生效」的名单做判定：拒的是改完之后的那个矛盾状态。
      const projected = roster.map((p) =>
        p.id === passengerId ? { visaExempt: true } : { visaExempt: p.visaExempt },
      );
      assertNoVisaContradiction({ visaStatus: order.visaStatus, passengers: projected });
    }

    // ── 3. 乘客级转移走状态机：DECLARE_SELF_ARRANGED / REVOKE_SELF_ARRANGED ──────────
    // false→true 门槛：送签已在办理（材料准备/已送签）→ 人为确认（签证岗 0830 口径）。
    // 不硬拦也不自动退：批文成本已发生，退不退/退多少由操作人当场定（默认 0）。缺确认参数时
    // 转移表拒绝（NEED_CONFIRM_SUBMITTED），抛带 [NEED_CONFIRM_SUBMITTED] 标记的冲突错，
    // 前端据此弹退费确认框后重试。文案只在状态机里定义一份。
    const submittedInProcess =
      input.visaExempt && passenger.visaSubmissionStatus !== VisaSubmissionStatus.PENDING;
    const transition = transitionPassengerVisa(
      {
        orderVisaStatus: order.visaStatus,
        visaExempt: passenger.visaExempt,
        visaSubmissionStatus: passenger.visaSubmissionStatus,
        allPassengersExempt: false,
      },
      input.visaExempt
        ? { type: 'DECLARE_SELF_ARRANGED', submittedConfirmed: Boolean(input.submittedOverride) }
        : { type: 'REVOKE_SELF_ARRANGED' },
    );
    if (!transition.ok) {
      throw new ConflictError(transition.reason);
    }
    // 幂等短路已在上方判过（现值 ≠ 目标值才走到这里），转移表必然给出两列写入。
    const passengerWrite = transition.write.passenger;
    if (!passengerWrite || passengerWrite.visaExempt === undefined) {
      throw new Error('签证状态机未给出自备签写入（不该发生）');
    }

    // ── 4. 历史冲突闸（fail-closed）：换人通道时代已给该乘客补过自备签减免的钱 ──
    // 两套钱法（调整行 vs 行重算）叠加会双计，这里直接拒，交人工核对。
    const priorAdjustments = Array.isArray(order.adjustments)
      ? (order.adjustments as unknown as OrderAdjustmentEntry[])
      : [];
    const hasSwapReversal = priorAdjustments.some(
      (e) => e?.type === 'SWAP_VISA_DEDUCT_REVERSAL' && e?.passengerId === passengerId,
    );
    if (hasSwapReversal) {
      throw new ConflictError(
        '该乘客此前经换人通道调整过自备签减免，请人工核对后走调价通道处理',
      );
    }

    // ── 5. 钱（仅 BUNDLE 行有钱的语义）：预检 → 翻标记 → 行重算 ────────────
    const bundleItems = await tx.orderItem.findMany({
      where: { orderId, kind: OrderItemKind.BUNDLE },
      select: { id: true, quantity: true, amount: true, metadata: true },
    });
    const readAddOnSnapshot = (raw: unknown): Partial<BundleAddOnBreakdown> | null => {
      const meta =
        raw != null && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      const addOns = meta?.addOns;
      return addOns != null && typeof addOns === 'object' && !Array.isArray(addOns)
        ? (addOns as Partial<BundleAddOnBreakdown>)
        : null;
    };
    const snapshotRate = (raw: unknown): number => {
      const s = readAddOnSnapshot(raw);
      return Math.max(0, Math.trunc(Number(s?.selfVisaDeductCny ?? 0) || 0));
    };
    // 有钱语义的行：建单快照里配了自备签减免费率（>0）。费率=0 或无快照 → 纯改标记。
    const moneyLines = bundleItems.filter((it) => snapshotRate(it.metadata) > 0);
    if (moneyLines.length > 0) {
      if (order.settlementLocked) {
        throw new ConflictError('结算价已锁定，改自备签会变更套餐应收，请先解锁结算价再操作');
      }
      // 开票闸（与改结算价同口径）：发票是已交付下游的凭证，改价必须先冲开票状态再改。
      if (order.outboundInvoiced || order.returnInvoiced || order.systemInvoiced) {
        throw new ConflictError(
          '该订单已有开票记录（去程/回程/系统任一已开），改自备签会使发票与订单金额不一致。' +
            '请先在票务台把对应开票状态改回「未开」，改完后如需可重新开票。',
        );
      }
      if (moneyLines.length > 1) {
        throw new ConflictError(
          '本单存在多条含自备签减免的套餐行，系统无法自动分摊差额，请人工核对后走调价通道处理',
        );
      }
    }
    // 已送签人为确认 + 本单没有减免费率行：翻标记本就不动钱，没有"从减免里退"的来源。
    if (
      submittedInProcess &&
      input.submittedOverride &&
      moneyLines.length === 0 &&
      input.submittedOverride.refundCny > 0
    ) {
      throw new ConflictError(
        '本单套餐未配自备签减免费率，改自备签不产生退费；如需退款请走收款/调价通道',
      );
    }

    // ── 6. 写乘客标记（唯一写点）；转移表两个方向都把送签进度置回待处理 ─────────
    // true→false：防旧 CONFIRMED 复活污染任务派生（人已换办签方式，进度从头来）；
    // false→true：门槛已保证本就是 PENDING，写入幂等。
    await writePassengerVisaExempt(tx, passengerId, {
      visaExempt: passengerWrite.visaExempt,
      visaSubmissionStatus: passengerWrite.visaSubmissionStatus,
    });

    // ── 5b. 行重算（唯一钱行）：以翻转后的乘客现势重算自备签人数，其余维度沿用原快照 ──
    let totalDeltaCny = 0;
    // 已送签人为确认的钱结果（仅 submittedOverride 路径有值）：客人实退 / 批文成本留存。
    let refundCnyApplied: number | null = null;
    let retainCny = 0;
    if (moneyLines.length === 1) {
      const line = moneyLines[0];
      const snapshot = readAddOnSnapshot(line.metadata)!;
      const rate = snapshotRate(line.metadata);
      const num = (v: unknown): number => Number(v ?? 0) || 0;
      const intNN = (v: unknown): number => Math.max(0, Math.trunc(num(v)));
      // 占座三计数从快照回放（缺失时回落行 quantity 的旧口径，与改档同源）。
      const occupancy = resolveBundleOccupancy(
        snapshot.adultCount != null || snapshot.childCount != null || snapshot.infantCount != null
          ? {
              adultCount: intNN(snapshot.adultCount),
              childCount: intNN(snapshot.childCount),
              infantCount: intNN(snapshot.infantCount),
              quantity: line.quantity,
            }
          : { quantity: line.quantity },
      );
      const resolvedNights = Math.max(1, Math.trunc(num(snapshot.nights) || 1));
      const bundleCfg = {
        hotelNights: resolvedNights,
        singleSupplementCnyPerNight: intNN(snapshot.singleSupplementCnyPerNight),
        businessUpgradeCnyPerLeg: intNN(snapshot.businessUpgradeCnyPerLeg),
        childSeatDiscountCnyPerPerson: intNN(snapshot.childSeatDiscountCnyPerPerson),
        infantPriceCny: intNN(snapshot.infantPriceCny),
        selfVisaDeductCny: rate,
        legs: Math.max(1, Math.trunc(num(snapshot.legs) || 1)),
      };
      const singleCount = intNN(snapshot.singleCount);
      const businessSplit: BundleBusinessUpgradeSplit = {
        outbound: intNN(snapshot.businessCountOutbound),
        return: intNN(snapshot.businessCountReturn),
      };
      const oldCount = intNN(snapshot.selfProvidedVisaCount);
      // 翻转后的乘客现势 → 权威自备签人数（与录单 priceAndValidateItems 同一纯函数）。
      const paxNow = await tx.passenger.findMany({
        where: { orderId },
        select: { visaExempt: true },
      });
      const { selfProvidedVisaCount: newCount } = derivePerPaxBundleOptions({}, paxNow);

      // hotelStamp 传 null、晚数用快照 nights：绝不重读现价配置/现房型，重算只反映
      // 「自备签人数变了」这一件事。
      const oldAddOn = computeBundleAddOn(
        bundleCfg, null, singleCount, businessSplit, occupancy, resolvedNights, oldCount,
      );
      const newAddOn = computeBundleAddOn(
        bundleCfg, null, singleCount, businessSplit, occupancy, resolvedNights, newCount,
      );
      totalDeltaCny = round2(newAddOn.total - oldAddOn.total);

      // 守恒断言：翻一个人 = 恰好一份快照费率。对不上（快照与乘客现势漂移、clamp 生效等）
      // 说明这单的钱不能自动算，抛错回滚交人工。
      const expectedDelta = input.visaExempt ? -rate : rate;
      if (totalDeltaCny !== expectedDelta) {
        throw new ConflictError(
          `自备签减免重算与建单快照不符（重算差额 ¥${totalDeltaCny}，应为 ¥${expectedDelta}），` +
            '请人工核对该单套餐快照后走调价通道处理',
        );
      }

      const oldAmount = Number(line.amount.toString());
      const newAmount = round2(oldAmount + totalDeltaCny);
      if (newAmount < 0) {
        throw new ConflictError('重算后套餐行金额为负，请人工核对后走调价通道处理');
      }
      const lineMeta = (line.metadata ?? {}) as Record<string, unknown>;
      await tx.orderItem.update({
        where: { id: line.id },
        data: {
          amount: new Prisma.Decimal(newAmount),
          // 快照同步：套餐改档等下游读 metadata.addOns.selfProvidedVisaCount，必须跟上现势。
          metadata: {
            ...lineMeta,
            addOns: newAddOn.breakdown,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      // 锁内重新聚合最新 items 算 subtotal/total（与改结算价同款，天然吃到并发已提交的改动）。
      const sumAgg = await tx.orderItem.aggregate({ where: { orderId }, _sum: { amount: true } });
      const newSubtotal = round2(
        Number((sumAgg._sum.amount ?? new Prisma.Decimal(0)).toString()),
      );
      await tx.order.update({
        where: { id: orderId },
        data: {
          subtotal: new Prisma.Decimal(newSubtotal),
          total: new Prisma.Decimal(newSubtotal),
        },
      });

      // ── 5c. 已送签人为确认的钱收口：行重算已把整份减免退了（−rate），实际只该退 refund，
      // 差额（rate−refund）作为「批文成本留存」补回应收（adjustments 流水，财务可见可查）。
      // 净效果 = 应收只降 refund。refund 超过费率直接拒（不是静默钳位——填错要看得见）。
      if (submittedInProcess && input.submittedOverride) {
        const refund = Math.trunc(input.submittedOverride.refundCny);
        if (refund > rate) {
          throw new ConflictError(`退费金额不能超过该单自备签减免费率 ¥${rate}`);
        }
        refundCnyApplied = refund;
        retainCny = rate - refund;
        if (retainCny > 0) {
          const log = appendAdjustment(order.adjustments, {
            type: 'VISA_SUBMITTED_COST_RETAIN',
            label: '已送签批文成本留存（改自备签少退）',
            amountCny: retainCny,
            at: new Date().toISOString(),
            by: actor.userId,
            note: input.submittedOverride.reason,
            passengerId,
          });
          await tx.order.update({
            where: { id: orderId },
            data: { adjustmentCny: order.adjustmentCny + retainCny, adjustments: log },
          });
        }
      }
    }

    // ── 7. 任务联动：先对齐任务的有无（补建/撤 PENDING），再按人重派生任务状态 ──
    await syncVisaTasksForOrder(tx, orderId, { userId: actor.userId, role: actor.role });

    const nonExempt = await tx.passenger.findMany({
      where: { orderId, visaExempt: false },
      select: { visaSubmissionStatus: true },
    });
    let warning: string | null = null;
    if (nonExempt.length > 0) {
      // 任务级状态唯一重派生点。重派生范围：仅 PENDING/IN_PROGRESS（CONFIRMED/FAILED/CANCELLED
      // 不动——已出结果或已终态的任务不被系统悄悄改写）。
      await rederiveVisaTaskStatus(tx, orderId, {
        touch: [FulfillmentStatus.PENDING, FulfillmentStatus.IN_PROGRESS],
        statuses: nonExempt.map((p) => p.visaSubmissionStatus),
      });
    } else {
      // ── 8. 全员自备签但仍有非 PENDING 的签证任务（sync 按设计只撤 PENDING）→ 警示 ──
      const stuckTasks = await tx.fulfillmentTask.count({
        where: {
          orderItem: { orderId },
          type: FulfillmentType.VISA_APPLICATION,
          status: { in: [FulfillmentStatus.IN_PROGRESS, FulfillmentStatus.CONFIRMED] },
        },
      });
      if (stuckTasks > 0) {
        warning =
          '本单乘客现已全部自备签，但仍有正在办理/已办结的签证任务未撤销（系统只自动撤「待处理」的任务），请签证岗人工处置该任务及相关费用。';
      }
    }

    // 按人份额落库（R1）：本事务改了应收 / 行金额，提交前把每人份额重算落库（写点见 service/passenger-shares.ts）。
    await persistPassengerShares(tx, orderId);
    return {
      noop: false as const,
      orderNumber: order.orderNumber,
      before,
      totalDeltaCny,
      refundCnyApplied,
      retainCny,
      warning,
    };
  });

  // 办结派生对齐：进度被重置回待处理后，若订单的「已签证」是系统办结写的要对称撤销
  // （录单手选的已签证没有办结审计，不受影响）。放在事务外，与派生模块的调用点约定一致。
  if (!scratch.noop) {
    await syncOrderVisaCompletion(orderId, { userId: actor.userId, role: actor.role });
  }

  const finalOrder = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: ORDER_FULL_INCLUDE,
  });
  const serialized = serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role));

  if (scratch.noop) {
    return { order: serialized, warning: null, idempotent: true, audit: null };
  }
  return {
    order: serialized,
    warning: scratch.warning,
    idempotent: false,
    audit: {
      orderNumber: scratch.orderNumber,
      passengerId,
      before: scratch.before,
      after: { visaExempt: input.visaExempt, visaSubmissionStatus: VisaSubmissionStatus.PENDING },
      totalDeltaCny: scratch.totalDeltaCny,
      // 已送签人为确认（非该路径时为 null/0）：实退给客人 / 批文成本留存
      refundCny: scratch.refundCnyApplied,
      retainCny: scratch.retainCny,
    },
  };
}

