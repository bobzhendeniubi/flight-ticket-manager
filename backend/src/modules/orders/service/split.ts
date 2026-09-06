// 由 orders.service.ts 机械拆出（审查根因 R5，2026-09-06）：只搬代码、不改口径。
// 对外契约仍从 ../orders.service.js 取（facade 原名再导出）；OrderService 方法体在这里是
// `export function xxx(svc: OrderService, ...)`，方法里的 `this.` 一律写成 `svc.`——
// 跨组调用仍走 facade 实例，单测里对 OrderService 实例的 spy 行为不变。

import {
  AuditSeverity,
  AuditTargetType,
  BundleChangeRequestStatus,
  CabinClass,
  CommissionStatus,
  OrderChangeKind,
  OrderChangeRequestStatus,
  OrderItemKind,
  PaymentMethod,
  PaymentStatus,
  PrepaymentTxType,
  Prisma,
  RefundStatus,
  SettlementRequestStatus,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../lib/errors.js';
import { isReturnCurrentlyReleased } from '../orders.leg-status.js';
import { computePerPaxShares, spreadableAdjustmentCny } from '../per-pax-share.js';
import { groupPassengerAdjustments } from '../order-adjustment-lines.js';
import { payableCny } from '../../../lib/order-money.js';
import {
  deriveRoomsToMove,
  isTerminalLegItem,
  movedUnitsFor,
  occupancyOfPassengers,
  planItemMove,
  readUpgradeCount,
  resolveUpgradeToMove,
  roundHalfGrid,
  type SplitContext,
  type SplitItemView,
  type SplitMove,
  type SplitOccupancy,
  type SplitRowPatch,
} from '../split-move-strategies.js';
import {
  assertOrderAllowsFundsDisposal,
  sumCompletedRefundsWithinTx,
} from '../../../lib/funds-guard.js';
import { OPERATION_FEE_CNY_PER_ORDER } from '../order-cost-items.service.js';
import {
  DERIVABLE_TASK_STATUSES,
  ourVisaPassengersWhere,
  rederiveVisaTaskStatus,
} from '../../fulfillment/visa-state.js';
import { syncOrderVisaCompletion } from '../../fulfillment/visa-completion.js';
import { determineFlightLegItems } from '../ticketing-cap.js';
import { FulfillmentStatus, FulfillmentType } from '@prisma/client';
import { readJsonObject, type SplitOrchestrationSnapshot } from './leg-action-log.js';
import {
  type SplitConservationRow,
  sumFlightQuantities,
  sumFlightUpgradeCounts,
  sumRoomsBilledHalves,
  sumTotalCostCents,
} from './order-ledger.js';
import { runOrderMutation, type MutationDb } from './order-mutation.js';
import {
  actorCan,
  appendAdjustment,
  generateOrderNumber,
  round2,
  SEAT_HOLDING_STATUSES,
  syncOrderHasReturnLeg,
  syncOrderLegFlag,
  zhStatus,
} from './shared.js';
import {
  carryVisaTaskForSplit,
  createFulfillmentTasks,
  syncVisaTasksForOrder,
} from './visa-sync.js';
import type { OrderService } from '../orders.service.js';

// ════════════════════════════════════════════════════════════════════
// 拆单 v1（split PNR 售后逃生门）：把选中乘客从源订单拆出成新订单。
//
// 顶层哲学（改本区代码前先读三遍）：
//   1. 拆单是搬钱不是算钱：unitPrice 全冻结，只动 quantity 与显式差额行 ——
//      任何「重新定价」都不属于拆单；
//   2. 绝不动库存：座位 sold 一分不动（拆前拆后逐班次舱位 Σquantity 恒等，
//      两单加起来占的还是同一批座位）；
//   3. fail-closed：任何守恒断言（total / paidAmount / 座位数量）不平即抛错，
//      整个事务回滚，宁可拆不成也不能拆出一笔对不上的账。
// ════════════════════════════════════════════════════════════════════

/**
 * 拆单准入闸 + 每人份额评估（preview 与 execute 共用同一口径，避免预检放行、执行另算）。
 * 只读不写；blockers 为空 = 可拆。warnings 是**非阻断**提示，只给运营看，不影响可拆判定。
 */
export async function assessOrderSplit(
  svc: OrderService,
  db: Prisma.TransactionClient,
  order: SplitSourceOrder,
  passengerIds: string[],
  options: { autoSplitRoomGroups?: boolean } = {},
): Promise<SplitAssessment> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const autoSplitRoomGroups = options.autoSplitRoomGroups === true;

  // ── 闸 1-3：存活 / 占座中 / 资金处置闸（前两条通过才跑处置闸，避免同因重复报）──
  if (order.deletedAt) {
    blockers.push('订单已在回收站，不能拆单。请先恢复订单。');
  } else if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
    blockers.push(`订单当前状态（${zhStatus(order.status)}）不可拆单：仅占座中的有效订单可拆。`);
  } else {
    try {
      assertOrderAllowsFundsDisposal(order, '拆单');
    } catch (err) {
      blockers.push(err instanceof Error ? err.message : '订单当前状态不允许拆单。');
    }
  }

  // ── 闸 4-5（已放开）：两把锁**跟随**到新单，不再拒拆 ────────────────────────
  // 旧口径拒拆锁定单，于是「财务锁完价、客人 no-show」就彻底没路可走（no-show 按人拆单是
  // 唯一通道）。锁本身是「别再动这单的钱」的意思，拆单不改单价、只按每人份额搬钱 ——
  // 真正的风险不是拆，而是**拆完新单没锁**：新单 create 此前根本不写这两组字段，
  // 等于静默解锁，谁都能去新单上改结算价/撤认款。现口径：新单继承两把锁与
  // LockedAt/LockedBy（见执行段建新单），两侧同锁，谁也别想借拆单绕开复核。
  if (order.settlementLocked || order.paymentsLocked) {
    warnings.push(
      '本单已锁定（结算价 / 收款复核）：拆出的新单会**继承同样的锁**，' +
        '如需改动两侧金额请先各自解锁。',
    );
  }

  // ── 闸 6（已放开）：开票位随人搬家，不再拦已开票的单 ──────────────────────
  // 旧口径把三个开票位当成「发票金额与订单金额挂钩」而拒拆。但六态开票（去程/回程/系统）
  // 是**给航司出票 / 系统出票的进度标记，不是发票**（口径见 ticketing-cap.ts 顶部注释与
  // 财务岗操作手册的开票一节）：它记的是「这一段票开没开」，不承载金额。
  // 现口径：拆单时把三个位原样复制给新单、源单保持不变 —— 拆出去的人本来就已出票，
  // 新单当然也是已出票态。班次开票额度按「被标记订单的乘客数」算，拆前 n 人一份、
  // 拆后 (n−k) + k 仍是 n 人，额度不增不减（执行段有守恒断言兜底，见步骤 11）。

  // ── 闸 7：佣金分档 ──────────────────────────────────────────────────────
  // no-show / 按人改期发生时，佣金**必然还是 ACCRUED**（代理飞完 7 天后才申请结算），
  // 一律拒拆等于把这两条售后路全堵死。故按状态分档：
  //   · ACCRUED 且未挂结算单 → 随拆按份额劈成两条（rate / chainDepth 原样，Σ amount 恒等，
  //     执行段落 CRITICAL 审计 SPLIT_ORDER_COMMISSION）；
  //   · SETTLEMENT_REQUESTED / SETTLED（或已挂 settlementId）→ 钱已经进了结算单，
  //     拆开两侧就与结算单对不上 —— 保留拒绝，请财务先处理。
  const commissionRows = await db.commissionRecord.findMany({
    where: {
      orderId: order.id,
      status: {
        in: [
          CommissionStatus.ACCRUED,
          CommissionStatus.SETTLEMENT_REQUESTED,
          CommissionStatus.SETTLED,
        ],
      },
    },
    select: { id: true, amount: true, status: true, settlementId: true },
  });
  const commissionCny = round2(
    commissionRows.reduce((sum, r) => sum + Number(r.amount), 0),
  );
  const commissionSettling = commissionRows.filter(
    (r) => r.status !== CommissionStatus.ACCRUED || r.settlementId != null,
  );
  // 负数 REVERSED 补偿行（退款/部分冲销产生、尚未并入结算单）同样挂在本单上：
  // 结算引擎按 settlementId=null 扫它们去追回多付的佣金。整块留在源单，
  // 拆出去那部分的追回就永远算在源单头上 —— 与两侧份额对不上，故按同一比例一并劈。
  const reversalRows = await db.commissionRecord.findMany({
    where: {
      orderId: order.id,
      status: CommissionStatus.REVERSED,
      settlementId: null,
      amount: { lt: 0 },
    },
    select: { id: true, amount: true },
  });
  const commissionReversalCny = round2(
    reversalRows.reduce((sum, r) => sum + Number(r.amount), 0),
  );
  let commissionMode: 'NONE' | 'SPLIT' | 'BLOCKED' = 'NONE';
  if (commissionSettling.length > 0) {
    commissionMode = 'BLOCKED';
    blockers.push('本单佣金已进结算流程，请财务先处理后再拆。');
  } else if (commissionRows.length > 0 || reversalRows.length > 0) {
    commissionMode = 'SPLIT';
    if (commissionRows.length > 0) {
      warnings.push(
        `本单已计提佣金 ¥${commissionCny}（尚未进结算）：拆单会把它按两侧份额劈成两条，合计不变。`,
      );
    }
    if (reversalRows.length > 0) {
      warnings.push(
        `本单有待追回的佣金冲销 ¥${commissionReversalCny}（尚未进结算）：拆单会按两侧份额劈开，合计不变。`,
      );
    }
  }

  // ── 闸 8：进行中的退款 ──
  const inflightRefunds = await db.refund.count({
    where: {
      orderId: order.id,
      status: { in: [RefundStatus.REQUESTED, RefundStatus.APPROVED, RefundStatus.PROCESSING] },
    },
  });
  if (inflightRefunds > 0) {
    blockers.push('该订单有进行中的退款，请先完成或驳回退款流程再拆单。');
  }

  // 可摊售后费（= adjustmentCny − 换人费/换人差价等 excludeFromPerPax 条目）：
  // 闸 9 的提示语与下方的份额/分摊计算共用这一个数，两处分别算会漂。
  const spreadableAdjCny = spreadableAdjustmentCny(order);

  // ── 闸 9（已放开）：售后费用按份额随拆分摊 ────────────────────────────────
  // 旧口径拒拆带售后费的单（「整单口径，拆开就分不清谁欠的」）。改期费本就是按人产生的钱，
  // 均摊到每人份额里再随人搬走，比把整笔留在源单更诚实：
  //   两侧 Σ adjustmentCny 恒等（执行段有断言），应收也恒等 —— 见执行段的份额收敛。
  // 例外：换人费 / 换人差价（excludeFromPerPax）挂在**已经不在这张单上**的被换人头上，
  // 不进任何在册乘客的份额，也就不随拆 —— 整条留在源单（换人是在源单上发生的）。
  if (order.adjustmentCny !== 0) {
    const excludedCny = round2(order.adjustmentCny - spreadableAdjCny);
    warnings.push(
      excludedCny !== 0
        ? `本单有售后费用 ¥${order.adjustmentCny}，其中 ¥${excludedCny} 是换人费/换人差价` +
            `（记在被换下去的人头上）不随拆、整条留在本单；其余 ¥${spreadableAdjCny} 按两侧份额分摊，合计不变。`
        : `本单有售后费用 ¥${order.adjustmentCny}（改期费等）：拆单会按两侧份额分摊，合计不变。`,
    );
  }

  // ── 闸 10：套餐行数量 & 改档申请 ─────────────────────────────────────────
  // 套餐单已支持拆单（见 split-move-strategies 的 moveBundle）。仍要拦两种情况：
  //   · 多条套餐行 —— 「拆哪一张、人数快照按谁重建」无从判定（与 resolveChangeableBundleRow
  //     的多套餐行口径一字不差，不猜）；
  //   · 有待确认的改档申请 —— 申请里冻的是「拆之前这张单」的人数与档次，拆完再确认执行，
  //     差额会按已经不存在的人数算。
  const bundleRows = order.items.filter((it) => it.kind === OrderItemKind.BUNDLE);
  if (bundleRows.length > 1) {
    blockers.push('本单含多条套餐行，暂不支持拆单，请联系技术处理。');
  }
  // 改档申请闸**不按有没有套餐行分档**：申请是挂在订单上的（BundleChangeRequest.orderId），
  // 套餐行可能在提交申请之后被改掉/拆走，「没套餐行 = 不可能有待确认申请」并不成立。
  // 一律查一次，代价是一条 count。
  const pendingBundleChange = await db.bundleChangeRequest.count({
    where: { orderId: order.id, status: BundleChangeRequestStatus.PENDING },
  });
  if (pendingBundleChange > 0) {
    blockers.push('本单有待确认的套餐改档申请，请先确认或驳回该申请再拆单。');
  }
  // 议价申请（SettlementRequest）同理：申请里冻的是「拆之前这张单」的应收，
  // 拆完再确认执行，差额会按已经不存在的应收算 —— 先处理完再拆。
  const pendingSettlementRequest = await db.settlementRequest.count({
    where: { orderId: order.id, status: SettlementRequestStatus.PENDING },
  });
  if (pendingSettlementRequest > 0) {
    blockers.push('本单有待处理的议价申请，请先处理后再拆。');
  }
  // 改单申请（OrderChangeRequest）同理：申请里冻的是「拆之前这张单」的那一行
  //（itemId / 航段 / 房型 / 升舱补差按当时人数算），拆完那一行可能已经搬到新单上、
  // 或者人数已经变了，再确认执行就是按已经不存在的行改单 —— 先处理完再拆。
  //
  // ⚠ kind=SPLIT 的申请**排除在外**，两个理由：
  //   1. 这条闸拦的是「冻了某一行」的申请，而拆单申请冻的是乘客名单，没有 itemId；
  //      名单还成不成立由拆单自己判（「所选乘客不属于本订单，请刷新后重试」），
  //      不需要这条闸代劳。
  //   2. 更要紧的是：运营从队列里确认一条拆单申请时，那条申请自己还挂在 PENDING ——
  //      不排除就等于「拆单申请永远拆不动」，它每次都把自己算成阻拦自己的那一条。
  //      一单一类只能有一条待处理（部分唯一索引兜底），所以这里最多只漏掉自己这一条。
  const pendingOrderChangeRequest = await db.orderChangeRequest.count({
    where: {
      orderId: order.id,
      status: OrderChangeRequestStatus.PENDING,
      kind: { not: OrderChangeKind.SPLIT },
    },
  });
  if (pendingOrderChangeRequest > 0) {
    blockers.push('本单有待处理的改单申请，请先确认执行或驳回后再拆单。');
  }

  // ── 闸 10c：用过代理预存余额抵扣的单不许拆（口径同改归属的资金纠缠阻断）───────
  // 预存抵扣的真源是 PrepaymentTransaction(OFFSET) 流水，它**按 orderId 挂在源单上**
  //（Order.prepaymentOffset 那一列没有任何生产代码写入，恒为 0，指望不上）。
  // 拆单只搬 paidAmount，流水一条都搬不走 —— 新单退款时按 orderId 查不到任何 OFFSET，
  // 会把「本来是从余额里扣的钱」当成真现金全额退出去，等于凭空多退一笔。
  // 最小安全动作：先由财务把这笔抵扣结清/冲回，再拆。
  const splitBalanceOffset = await db.prepaymentTransaction.findFirst({
    where: { orderId: order.id, type: PrepaymentTxType.OFFSET },
    select: { id: true },
  });
  if (splitBalanceOffset != null) {
    blockers.push(
      '该单有预存余额抵扣记录，拆分后新单退款会按现金全额退出，请先由财务结清或冲回后再拆。',
    );
  }

  // ── 闸 11（已放开）：升舱行随拆按人劈开 ──────────────────────────────────
  // 旧口径拒拆含升舱的单。但升舱镜像账（metadata.businessUpgradeCount）本来就是逐行落库、
  // 逐行对称释放的，拆的时候把它按人劈到两侧即可 —— 执行段有「逐班次 Σ min(升舱位, 座位数)
  // 拆前后相等」的守恒断言兜底。未显式给 upgradeSplit 时按占座人头自动派生
  //（升舱行清单在下面算完两侧人数后一并产出，供预检回显）。

  // ── 闸 11b：回程座位当前处于「已释放」态 ─────────────────────────────────────
  // 释放快照（returnReleased.releasedSeats）记的是「这一行在**这张单上**放了几座」，
  // 而它是不可继承的（见 NON_INHERITABLE_ITEM_METADATA_KEYS）：拆完之后
  //   · 新单：回程行没有释放快照，「恢复回程」按钮无从下手，那几座回不来；
  //   · 源单：快照还记着按拆前人数放掉的座数，恢复时会照旧数占回来 —— 人已经少了一批，
  //     占回的座数却没变，座位账凭空多出一截。
  // 两边人数与释放快照必然对不上，且没有任何路径会自己纠正。先恢复、或确认这段就此作废再拆。
  if (order.items.some((it) => isReturnCurrentlyReleased(it))) {
    blockers.push(
      '本单回程座位当前处于「已释放」态，拆单会让释放快照与两侧人数对不上；' +
        '请先「恢复回程」或确认作废后再拆。',
    );
  }

  // ── 闸 12（已放开）：已出票单同样可拆，票务状态随人搬家 ────────────────────
  // 旧口径拒拆已出票单、让运营「走改签流程」，可**已出票的多人单恰恰是最需要单独改期的**：
  // 三人一单已出票，只给一位客人改航班，除了拆单没有别的路（一单一行程是全站硬约束）。
  // 航司标准做法 Divide PNR 本来就是对已出票 PNR 做的：票跟着人走，拆完再对那个人改签重出票。
  // 现口径同此 ——
  //   · 乘客整行物理搬到新单，pnr / eticketNumber 原样跟着走（步骤 5 只改 orderId）；
  //   · 开票位复制给新单（闸 6 注释）；FLIGHT_TICKETING 履约任务镜像源单状态（步骤 9）；
  //   · 之后对新单改期会走 rescheduleOrderItem 的「换班次即作废原票」（清新单乘客票号 +
  //     翻回新单被改航段的开票位），源单留守乘客的票与开票位一概不受影响。
  // 只作为**非阻断提示**回给运营，让人知道拆完之后票务台要重开票。
  const confirmedTicketing = await db.fulfillmentTask.count({
    where: {
      orderItem: { orderId: order.id },
      type: FulfillmentType.FLIGHT_TICKETING,
      status: FulfillmentStatus.CONFIRMED,
    },
  });
  const ticketedPax = order.passengers.some(
    (p) => (p.pnr && p.pnr.trim() !== '') || (p.eticketNumber && p.eticketNumber.trim() !== ''),
  );
  if (
    confirmedTicketing > 0 ||
    ticketedPax ||
    order.outboundInvoiced ||
    order.returnInvoiced ||
    order.systemInvoiced
  ) {
    warnings.push(
      '本单已出票：拆出的乘客票务状态（PNR/票号、开票位、出票任务）随人转到新单；' +
        '之后对新单改期会作废该乘客的票，需票务台重开。',
    );
  }

  // ── 非阻断提示：源单去程已标 no-show ──────────────────────────────────────
  // no-show / 释放 / 恢复的快照是「这一行在源单上发生过什么」，跨单继承会把幂等 token 与
  // 放座明细一起带走（见 NON_INHERITABLE_ITEM_METADATA_KEYS），所以执行段一律剔除。
  // 于是新单在系统里是「没标过 no-show」的干净单 —— 这件事得先告诉运营，别以为标记会跟着人走。
  const sourceNoShow = order.items.some(
    (it) =>
      it.kind === OrderItemKind.FLIGHT &&
      readJsonObject(readJsonObject(it.metadata).noShow).at != null,
  );
  if (sourceNoShow) {
    warnings.push(
      '源单去程已标 no-show，拆出的新单不会自动带标记：如果拆出去的这几位客人也没登机，' +
        '请到新单上再标一次 no-show。',
    );
  }

  // ── 闸 13（已放开）：已结清单同样可拆 ────────────────────────────────────
  // v1 一律拒绝「已收 ≥ 应收」的单，于是三人单付清后想单独给一个人改期就彻底没路可走
  //（拆单是按人改期的唯一通道）。复核搬款口径后放开：
  //   · movedPaid = max(0, min(movedShare, 已收 − 已完成退款))：已结清单必然
  //     movedPaid == movedShare（份额 ≤ 应收 ≤ 已收），
  //     → 新单 paid == total（结清）、源单 paid−movedShare == total−movedShare（仍结清）；
  //   · 两条守恒断言（total / paidAmount 拆前后合计相等）与座位数量断言恒成立；
  //   · 既不产生负应收，也不制造多收：多付单（已收 > 应收）只搬份额，多出来的钱留在源单原处。
  // 真正会对不上的是「已结清 + 代理单 → 佣金早已计提」，那由闸 7（已计提佣金）独立拦着，
  // 与本闸无关，放开本闸不会放过它。开票（闸 6）、退款（闸 8）、售后费（闸 9）同理各拦各的。
  const preTotalCny = round2(Number(order.total));
  const prePaidCny = round2(Number(order.paidAmount));

  // ── 闸 14：拆出人数 1 ≤ k < 全员，且全部属于本单 ──
  const allPaxIds = order.passengers.map((p) => p.id);
  const allPaxIdSet = new Set(allPaxIds);
  const movedIdSet = new Set(passengerIds);
  if (movedIdSet.size !== passengerIds.length) {
    blockers.push('拆出乘客列表中有重复项，请刷新后重试。');
  }
  const unknownIds = passengerIds.filter((id) => !allPaxIdSet.has(id));
  if (unknownIds.length > 0) {
    blockers.push('所选乘客不属于本订单（可能已被换人/拆走），请刷新后重试。');
  }
  if (unknownIds.length === 0 && movedIdSet.size >= allPaxIds.length) {
    blockers.push('拆出乘客数需少于全员：至少留 1 位乘客在原订单（整单转移请走改归属/改备注）。');
  }

  // ── 闸 15：同房组闸（一个房间不能一半在这单一半在那单）────────────────────
  // 手工拆单**保留**这道闸：运营自己在分房里把人分开，比系统替他猜怎么劈更靠谱。
  // no-show / 按人改期编排（autoSplitRoomGroups=true）则自动把混合房组按人劈成两个半组
  //（同酒店同房型同日期，房控把两个半间配回一间，房量不变）—— 那两条路径上运营
  // 根本没有「先去改分房」的机会，闸在那里只会变成死路。
  const roomGroups = readRoomGroups(order.roomAssignment);
  let roomGroupConflict = false;
  for (const group of roomGroups) {
    const groupPax = group.passengerIds;
    if (groupPax.length === 0) continue;
    const movedInGroup = groupPax.filter((id) => movedIdSet.has(id));
    if (movedInGroup.length > 0 && movedInGroup.length < groupPax.length) {
      roomGroupConflict = true;
      const label = group.label ?? '未命名房组';
      if (!autoSplitRoomGroups) {
        blockers.push(
          `房组「${label}」同时包含拆出与留下的乘客，请先在分房里把他们分到不同房组再拆单。`,
        );
        continue;
      }
      // 脏数据闸：0.5 间的房组里住着 2 位以上客人 —— 劈半后必有一侧落到 0 间却还住着人，
      // 房控从此少算一间。这是分房表本身填错了，系统不替它猜。
      const rawFraction = group.raw.roomFraction == null ? 1 : Number(group.raw.roomFraction);
      const groupHalves = Number.isFinite(rawFraction) ? Math.round(rawFraction * 2) : 2;
      if (groupHalves < 2 && groupPax.length >= 2) {
        blockers.push(
          `房组「${label}」记着 ${rawFraction} 间却住了 ${groupPax.length} 位客人（分房表数据有误）：` +
            '拆开后会有一侧住着人却占 0 间房。请先在分房里把这一组的间数改对，或拆成两个房组，再拆单。',
        );
      }
    }
  }

  // ── 闸 16：住宿行计费房数必须落在 0.5 网格上 ─────────────────────────────
  // 历史脏数据（如 roomsBilled=1.3）拆开后两侧都不是 0.5 的整数倍，房控与分房表从此对不上，
  // 且守恒断言用「半间」整数比会把小数尾巴静默抹掉。宁可先修数据再拆。
  for (const it of order.items) {
    if (it.roomsBilled == null) continue;
    const rooms = Number(it.roomsBilled);
    if (!Number.isFinite(rooms) || Math.abs(rooms * 2 - Math.round(rooms * 2)) > 1e-9) {
      blockers.push(
        `住宿行「${it.description}」的计费房数（${rooms}）不是 0.5 的整数倍，无法按半间拆分。` +
          '请先在分房/换酒店里把这一行的间数改成 0.5 的整数倍再拆单。',
      );
    }
  }

  // ── 每人份额（权威口径：per-pax-share 端口 + groupPassengerAdjustments 净额）──
  const { byPassenger } = groupPassengerAdjustments(
    order.items.map((it) => ({
      id: it.id,
      amount: Number(it.amount),
      description: it.description,
      passengerId: it.passengerId,
      metadata: it.metadata,
    })),
  );
  const netByPassenger = new Map<string, number>(
    Object.entries(byPassenger).map(([pid, bucket]) => [pid, bucket.netCny]),
  );
  const shareResult = computePerPaxShares({
    totalCny: preTotalCny,
    // 可摊售后费：换人费/换人差价（excludeFromPerPax）记在被换下去的人头上，不进任何在册乘客
    // 的份额 —— 拆单是「按每人份额搬钱」，把不属于任何人的钱摊进去会让两侧都拿到不该拿的数。
    // 这类钱整条留在源单（换人是在源单上发生的），见下方 movedAdjustmentCny。
    adjustmentCny: spreadableAdjCny,
    passengerIds: allPaxIds,
    netByPassenger,
  });
  const shareByPax = new Map(shareResult.rows.map((r) => [r.passengerId, r.shareCny]));
  const paxNameById = new Map(
    order.passengers.map((p) => [p.id, p.chineseName?.trim() || p.fullName]),
  );

  // movedShare 用分累加（份额本身逐分精确，round2 只防浮点尾数）。
  const movedShareCny = round2(
    passengerIds.reduce((sum, pid) => sum + (shareByPax.get(pid) ?? 0), 0),
  );
  // movedPaid = min(movedShare, 已收 − 已完成退款)，不为负 —— 只搬真的还在账上的钱。
  const completedRefundsCny = await sumCompletedRefundsWithinTx(db, order.id);
  const movedPaidCny = Math.max(
    0,
    Math.min(movedShareCny, round2(prePaidCny - completedRefundsCny)),
  );

  // ── 两侧人数解析（套餐行人数快照重建 / 房数派生的唯一权威口径）──
  const movedPassengers = order.passengers.filter((p) => movedIdSet.has(p.id));
  const keptPassengers = order.passengers.filter((p) => !movedIdSet.has(p.id));
  const movedOccupancy = occupancyOfPassengers(movedPassengers);
  const keptOccupancy = occupancyOfPassengers(keptPassengers);
  const occupancy = {
    movedOccupancy,
    keptOccupancy,
    movedSingleCount: movedPassengers.filter((p) => p.singleRoom).length,
    keptSingleCount: keptPassengers.filter((p) => p.singleRoom).length,
    movedSelfVisaCount: movedPassengers.filter((p) => p.visaExempt).length,
    keptSelfVisaCount: keptPassengers.filter((p) => p.visaExempt).length,
  };
  // 只拆出儿童/婴儿：套餐钱按**占座**比劈（婴儿不占座 → 一分钱不随拆走），
  // 拆出来的新单会是一张「有人没钱」的单。这不是错，但运营得知道自己在做什么。
  if (movedPassengers.length > 0 && movedOccupancy.adultCount === 0) {
    warnings.push(
      movedOccupancy.seatPax === 0
        ? '本次只拆出婴儿（不占座）：套餐款按占座人头分摊，新单应收为 0，成本按人头比例随拆。请确认这是你要的结果。'
        : '本次拆出的乘客里没有成人：套餐款按占座人头分摊，新单金额可能与直觉不同，请复核。',
    );
  }

  // ── 售后费按份额分摊 → 新单 total（应收 = total + adjustment，两者都不能重复计）──
  const payableCny = shareResult.payableCny;
  // 份额比夹到 [0,1]：按人调价可以把某几位的份额压成负数或超过整单应收
  //（净额是运营手填的），比值一旦越界，售后费/佣金按它分摊就会劈出「一侧为负、
  // 另一侧超过原值」的账。夹住比值，两侧「kept = 原 − moved」的 Σ 恒等仍然成立。
  const shareRatio = Math.min(
    1,
    Math.max(
      0,
      payableCny !== 0
        ? movedShareCny / payableCny
        : allPaxIds.length > 0
          ? movedIdSet.size / allPaxIds.length
          : 0,
    ),
  );
  // adjustmentCny 是**整数元**列（Order.adjustmentCny Int）：按份额取整分摊，
  // 留守侧取「原值 − 拆出侧」，两侧仍是整数且 Σ 恒等。
  //
  // 只摊**可摊**的那部分（spreadableAdjustmentCny）：换人费与换人差价挂在一个已经不在这张单上
  // 的人头上，excludeFromPerPax 已经把它们踢出了每人份额；分摊时若还按整数 adjustmentCny 劈，
  // 就会把这笔「谁都不属于」的钱按份额比塞进新单，新单凭空多一笔应收、源单少一笔 ——
  // 而被换下去的那个人是在**源单**上被换的，这笔钱本来就该整条留在源单。
  // 留守侧仍取「原值 − 拆出侧」，两侧 Σ adjustmentCny 恒等（执行段有断言）不受影响。
  const movedAdjustmentCny = Math.round(spreadableAdjCny * shareRatio);
  const targetTotalCny = round2(movedShareCny - movedAdjustmentCny);

  // ── 闸 17：按人调价把份额算成负数 / 超出整单应收 → 拒拆 ─────────────────────
  // computePerPaxShares 只保证 Σ 份额 == 应收，单个人的份额是运营手填的调价净额直接
  // 加出来的，可以为负、也可以大过整单应收。拿这种份额去搬钱，拆出来就是
  //「新单 1250、源单 −250」这种账 —— 守恒断言只看两侧之和，一分不差地放行。
  // 这里不静默夹逼：夹了 Σ 就不守恒，等于系统背着运营改了钱。宁可拒拆，
  // 让运营先把那一行调价改对。预检与执行段跑的是同一份闸（fail-closed）。
  const SHARE_EPS = 0.005;
  const negativeShareLabels = order.passengers
    .filter((p) => (shareByPax.get(p.id) ?? 0) < -SHARE_EPS)
    .map((p) => `${paxNameById.get(p.id) ?? p.id} ¥${round2(shareByPax.get(p.id) ?? 0)}`);
  if (negativeShareLabels.length > 0) {
    blockers.push(
      `按乘客调价后有人的份额为负（${negativeShareLabels.join('、')}）：` +
        '拆单只搬钱不改钱，负份额会把一侧订单金额拆成负数。请先调整该乘客的调价行再拆单。',
    );
  }
  // 两种触发原因分两句：运营看到的第一件事应该是「哪儿不对」，而不是一串数字里自己找。
  // ① 拆出份额本身就超过整单应收；② 拆完两侧里有一侧算出来是负数。
  const keptShareCny = round2(payableCny - movedShareCny);
  if (movedShareCny > payableCny + SHARE_EPS) {
    blockers.push(
      `按乘客调价后拆出份额超出整单应收（拆出 ¥${movedShareCny}，整单应收 ¥${payableCny}）：` +
        '拆单只搬钱不改钱，搬不出比整单还多的钱。请先调整相关乘客的调价行再拆单。',
    );
  }
  // targetTotalCny = 份额 − 分摊的售后费，是新单**基础总额**，不是应收（应收还要再加回
  // 新单自己的 adjustmentCny）。叫错名字会让运营拿它去对尾款，怎么对都对不上。
  if (keptShareCny < -SHARE_EPS || targetTotalCny < -SHARE_EPS) {
    blockers.push(
      `按乘客调价后拆完有一侧基础金额为负（新单基础总额 ¥${targetTotalCny} / 留守 ¥${keptShareCny}）：` +
        '负金额订单没有业务含义。请先调整相关乘客的调价行再拆单。',
    );
  }

  // ── 预存抵扣（Order.prepaymentOffset）随拆按份额搬 ────────────────────────
  // 这一列进「清账/尾款/已收净额」的每一条公式（应付 = total + adjustmentCny − paidAmount
  // − prepaymentOffset）。整块留在源单：源单 total 变小、抵扣没变 → 看起来多付；
  // 新单一分抵扣都没有 → 看起来欠款。两张单的尾款加起来不等于拆前那笔钱。
  // 现口径：按同一个份额比劈，留守侧取「原值 − 拆出侧」，Σ 恒等（执行段有断言）。
  // 注：这一列**没有生产代码写入**（恒为 0，见 orders.service 的预存抵扣注释），
  // 只有历史遗留数据才非零；老的 PrepaymentTransaction(OFFSET) 流水仍按单指向源单，
  // 故非零时执行段补一条 CRITICAL 审计留痕，供财务对账。
  const prePrepaymentOffsetCny = round2(Number(order.prepaymentOffset));
  const movedPrepaymentOffsetCny =
    prePrepaymentOffsetCny === 0 ? 0 : round2(prePrepaymentOffsetCny * shareRatio);

  // ── 建议间数 / 建议升舱位（预检回显 + 编排路径的自动派生，同一套口径）──
  const suggestCtx = buildSplitSuggestionContext({
    movedIdSet,
    totalPax: allPaxIds.length,
    occupancy,
  });
  const stayRows = order.items.filter(
    (it) =>
      (it.kind === OrderItemKind.HOTEL || it.kind === OrderItemKind.BUNDLE) &&
      (it.roomsBilled != null || it.hotelRoomTypeId != null),
  );

  return {
    blockers,
    warnings,
    shares: passengerIds
      .filter((pid) => allPaxIdSet.has(pid))
      .map((pid) => ({
        passengerId: pid,
        fullName: paxNameById.get(pid) ?? pid,
        shareCny: shareByPax.get(pid) ?? 0,
      })),
    allShareRows: shareResult.rows,
    movedShareCny,
    movedPaidCny,
    preTotalCny,
    prePaidCny,
    payableCny,
    movedAdjustmentCny,
    targetTotalCny,
    prePrepaymentOffsetCny,
    movedPrepaymentOffsetCny,
    /** 本单挂着预存余额抵扣流水吗（闸 10c 已据此拒拆；执行段留作防御性审计条件）。 */
    hasPrepaymentOffsetTxn: splitBalanceOffset != null,
    hotelItems: stayRows.map((it) => {
      const rooms = it.roomsBilled != null ? Number(it.roomsBilled) : null;
      const isBundleStay = it.kind === OrderItemKind.BUNDLE;
      return {
        itemId: it.id,
        // 套餐单没有独立 HOTEL 行，住宿盖章就在套餐行上 —— 前缀点明，别让运营以为选错了行。
        description: isBundleStay ? `套餐住宿 · ${it.description}` : it.description,
        roomsBilled: rooms,
        suggestedRoomsToMove:
          rooms != null && rooms > 0 ? deriveRoomsToMove(rooms, suggestCtx) : null,
        isBundleStay,
      };
    }),
    upgradeItems: collectSplitUpgradeItems(order.items, suggestCtx),
    commission: {
      mode: commissionMode,
      amountCny: commissionCny,
      reversalCny: commissionReversalCny,
    },
    roomGroupConflict,
    movedIdSet,
    occupancy,
  };
}

/**
 * 拆单预检（只读）：POST /orders/:id/split-preview。
 * 跑全部准入闸 + 份额计算，一次性返回全部不满足的闸（blockers），供运营在弹窗里逐条看。
 */
export async function previewOrderSplit(
  svc: OrderService,
  orderId: string,
  body: { passengerIds: string[]; autoSplitRoomGroups?: boolean },
  actor: { userId: string; role: UserRole },
): Promise<{
    eligible: boolean;
    blockers: string[];
    warnings: string[];
    shares: Array<{ passengerId: string; fullName: string; shareCny: number }>;
    movedShareCny: number;
    movedPaidCny: number;
    movedAdjustmentCny: number;
    hotelItems: SplitHotelItemView[];
    upgradeItems: SplitUpgradeItemView[];
    commission: { mode: 'NONE' | 'SPLIT' | 'BLOCKED'; amountCny: number; reversalCny: number };
    roomGroupConflict: boolean;
  }> {
  if (!actorCan(actor, 'orders.split')) {
    throw new ForbiddenError('仅运营/管理员可拆单');
  }
  const order = await loadOrderForSplit(prisma, orderId);
  if (!order) throw new NotFoundError('订单不存在');
  const assessment = await svc.assessOrderSplit(prisma, order, body.passengerIds, {
    autoSplitRoomGroups: body.autoSplitRoomGroups,
  });
  return {
    eligible: assessment.blockers.length === 0,
    blockers: assessment.blockers,
    warnings: assessment.warnings,
    shares: assessment.shares,
    movedShareCny: assessment.movedShareCny,
    movedPaidCny: assessment.movedPaidCny,
    movedAdjustmentCny: assessment.movedAdjustmentCny,
    hotelItems: assessment.hotelItems,
    upgradeItems: assessment.upgradeItems,
    commission: assessment.commission,
    roomGroupConflict: assessment.roomGroupConflict,
  };
}

/**
 * 执行拆单：POST /orders/:id/split。
 *
 * 事务内流程：锁源单（FOR UPDATE）→ 幂等回放检查 → 重跑准入闸 → 建新单（不定价不扣座）
 * → 按行搬/拆（FLIGHT/VISA/TRANSFER 按人数、HOTEL 按显式 roomSplit、按人调整行跟人走）
 * → 物理移乘客（PNR/票号随行）→ 两侧各一条 SPLIT 平账行 → 搬已收款（承接 Payment）
 * → 履约任务/出票任务镜像/回程列同步
 * → 守恒断言（total / paidAmount / 逐班次舱位 Σquantity / 各开票维度的乘客数）
 * → OrderSplitRecord 落库。
 * 幂等：同 (sourceOrderId, requestToken) 重试只回放既有结果，绝不二次拆。
 */
export async function splitOrder(
  svc: OrderService,
  orderId: string,
  input: SplitOrderInput,
  actor: { userId: string; role: UserRole },
): Promise<SplitOrderResult> {
  if (!actorCan(actor, 'orders.split')) {
    throw new ForbiddenError('仅运营/管理员可拆单');
  }

  // 订单号撞号（P2002）重试环 ≤3 次：Postgres 里语句失败会废掉整个事务，
  // 所以重试必须在事务外整体重来（每轮换一个新订单号），不能在事务内捕获后继续。
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const targetOrderNumber = await generateOrderNumber();
    try {
      // OrderMutation 内核（审查根因 R5）：幂等快路径（同 (源单, token) 已拆过 → 直接回放，不进事务）、
      // 事务 + 源单行锁 + 锁内幂等复查、事务内审计、提交后钩子，全部收在内核里。
      // 守恒断言仍是 executeSplitWithinTx §11 那份更细的（含开票人数 / 佣金 / 逐侧占座）；
      // 内核的通用五维快照是它的子集，这里不重复读一遍。
      return await runOrderMutation<SplitOrderResult>(
        {
          orderId,
          actor,
          action: 'SPLIT_ORDER',
          requestToken: input.requestToken,
          idempotency: { find: (db) => findSplitReplayIn(db, orderId, input.requestToken) },
          // 按人份额落库（R1）：搬人搬钱之后两侧各落一遍——源单清掉被拆走乘客的旧行、新单补建。
          persistShares: true,
        },
        async (ctx) => {
          const outcome = await svc.executeSplitWithinTx(
            ctx.tx,
            orderId,
            input,
            actor,
            targetOrderNumber,
          );
          // 新单是 body 里才有 id 的，点名进内核的份额落库名单。
          ctx.track(outcome.result.targetOrderId);

          // 审计**进事务**（原先事务外 fire-and-forget）：拆单是资金 / 库存动作，
          // 「谁把哪些人、多少钱拆到了哪张单」必须与拆单本身同生共死。两条 SPLIT_ORDER，各挂一侧订单。
          const auditBefore = {
            total: outcome.preTotalCny,
            paidAmount: outcome.prePaidCny,
            passengers: outcome.passengerSummary,
            perPaxRows: outcome.allShareRows,
          };
          const auditAfter = {
            sourceOrderNumber: outcome.result.sourceOrderNumber,
            targetOrderNumber: outcome.result.targetOrderNumber,
            sourceTotal: outcome.sourceTotalAfterCny,
            // 新单**落库的 total**（= 份额 − 随拆分摊的售后费），与 sourceTotal 同口径。
            // 从前这里写的是份额 movedShareCny：有售后费的单两者不等，
            // 一条审计里两侧却按两种口径记，财务照着对账永远差一个售后费。
            targetTotal: outcome.targetTotalCny,
            // 份额单独留一个字段（只增不删，读审计的前端 auditFormat 不受影响）。
            movedShareCny: outcome.result.movedShareCny,
            sourcePaid: outcome.sourcePaidAfterCny,
            targetPaid: outcome.result.movedPaidCny,
            movedPassengerIds: input.passengerIds,
            note: input.note ?? null,
          };
          await ctx.audit({
            action: 'SPLIT_ORDER',
            targetType: AuditTargetType.ORDER,
            targetId: outcome.result.sourceOrderId,
            targetLabel: outcome.result.sourceOrderNumber,
            before: auditBefore,
            after: auditAfter,
            severity: AuditSeverity.CRITICAL,
          });
          await ctx.audit({
            action: 'SPLIT_ORDER',
            targetType: AuditTargetType.ORDER,
            targetId: outcome.result.targetOrderId,
            targetLabel: outcome.result.targetOrderNumber,
            before: auditBefore,
            after: auditAfter,
            severity: AuditSeverity.CRITICAL,
          });
          // 佣金被劈开过 → 单独一条 CRITICAL 审计：财务日后对账时，「这条佣金怎么变成两条的」
          // 得有一处说得清（rate / chainDepth 未变、Σ amount 未变，只是分配到了两张单）。
          if (outcome.commissionSplit.length > 0) {
            await ctx.audit({
              action: 'SPLIT_ORDER_COMMISSION',
              targetType: AuditTargetType.ORDER,
              targetId: outcome.result.sourceOrderId,
              targetLabel: outcome.result.sourceOrderNumber,
              before: {
                records: outcome.commissionSplit.map((c) => ({
                  commissionId: c.commissionId,
                  agentId: c.agentId,
                  amountCny: c.beforeAmountCny,
                  rate: c.rate,
                  chainDepth: c.chainDepth,
                })),
              },
              after: {
                targetOrderNumber: outcome.result.targetOrderNumber,
                records: outcome.commissionSplit,
              },
              severity: AuditSeverity.CRITICAL,
            });
          }
          // 预存抵扣被搬走过 → 单独一条 CRITICAL 审计：预存流水（PrepaymentTransaction）
          // 仍按单指向源单，订单侧的抵扣列却已分到两张单，财务对账时得有一处说得清。
          if (outcome.prepaymentOffsetSplit) {
            await ctx.audit({
              action: 'SPLIT_ORDER_PREPAYMENT_OFFSET',
              targetType: AuditTargetType.ORDER,
              targetId: outcome.result.sourceOrderId,
              targetLabel: outcome.result.sourceOrderNumber,
              before: { prepaymentOffsetCny: outcome.prepaymentOffsetSplit.beforeCny },
              after: {
                targetOrderNumber: outcome.result.targetOrderNumber,
                sourcePrepaymentOffsetCny: outcome.prepaymentOffsetSplit.keptCny,
                targetPrepaymentOffsetCny: outcome.prepaymentOffsetSplit.movedCny,
                note: '预存抵扣按份额随拆搬移；预存流水仍按单挂在源单，请财务据本条对账',
              },
              severity: AuditSeverity.CRITICAL,
            });
          }
          // 订单级办结派生对齐（两侧各一次，**事务提交后**，与其它写送签进度的路径同一调用点约定）：
          // 名单一分为二后「非自备签乘客是否全部已送签」两侧各自重算——拆出去的两位已送签的人
          // 在新单上就该自动办结；源单若是派生办结写的已签证、剩下的人还没送出去则对称回退。
          // 幂等，重复调用零副作用。
          ctx.afterCommit(async () => {
            await syncOrderVisaCompletion(outcome.result.sourceOrderId, {
              userId: actor.userId,
              role: actor.role,
            });
            await syncOrderVisaCompletion(outcome.result.targetOrderId, {
              userId: actor.userId,
              role: actor.role,
            });
          });
          return outcome.result;
        },
      );
    } catch (err) {
      if (isUniqueViolation(err, 'orderNumber')) {
        lastError = err;
        continue; // 订单号撞号：换号重来
      }
      if (isUniqueViolation(err, 'requestToken') || isUniqueViolation(err, 'sourceOrderId')) {
        // 并发同 token 双击：另一请求已拆完 → 回放
        const raced = await svc.findSplitReplay(orderId, input.requestToken);
        if (raced) return raced;
      }
      throw err;
    }
  }
  throw lastError ?? new ConflictError('订单号生成连续撞号，请稍后重试');
}

/** 幂等回放：查 (sourceOrderId, requestToken) 既有拆单流水，命中则还原响应。 */
export async function findSplitReplay(svc: OrderService, orderId: string, requestToken: string): Promise<SplitOrderResult | null> {
  return findSplitReplayIn(prisma, orderId, requestToken);
}

/**
 * 同上，但客户端由调用方指定：OrderMutation 内核在事务外用裸 prisma 走快路径，
 * 拿到源单行锁后再用 tx 复查一次（并发同 token 双击，后到者在锁内命中回放）。
 */
export async function findSplitReplayIn(
  db: MutationDb,
  orderId: string,
  requestToken: string,
): Promise<SplitOrderResult | null> {
  const prior = await db.orderSplitRecord.findUnique({
    where: { sourceOrderId_requestToken: { sourceOrderId: orderId, requestToken } },
    include: {
      sourceOrder: { select: { orderNumber: true } },
      targetOrder: { select: { orderNumber: true } },
    },
  });
  if (!prior) return null;
  return {
    sourceOrderId: prior.sourceOrderId,
    sourceOrderNumber: prior.sourceOrder.orderNumber,
    targetOrderId: prior.targetOrderId,
    targetOrderNumber: prior.targetOrder.orderNumber,
    movedShareCny: round2(Number(prior.movedShareCny)),
    movedPaidCny: round2(Number(prior.movedPaidCny)),
    passengerCount: prior.passengerCount,
    replayed: true,
  };
}

/**
 * 拆单事务内核（只在 splitOrder 的 runOrderMutation 里调用）。
 * 源单行锁与锁内幂等复查已由 OrderMutation 内核完成：进到这里时源单行已 FOR UPDATE、
 * 同 (源单, token) 的既有拆单流水已排除。
 */
export async function executeSplitWithinTx(
  svc: OrderService,
  tx: Prisma.TransactionClient,
  orderId: string,
  input: SplitOrderInput,
  actor: { userId: string; role: UserRole },
  targetOrderNumber: string,
): Promise<{
  result: SplitOrderResult;
  preTotalCny: number;
  prePaidCny: number;
  sourceTotalAfterCny: number;
  /** 新单落库 total（份额 − 随拆分摊的售后费）——审计的 targetTotal 就取它。 */
  targetTotalCny: number;
  sourcePaidAfterCny: number;
  allShareRows: Array<{ passengerId: string; netCny: number; shareCny: number }>;
  passengerSummary: Array<{ id: string; name: string; moved: boolean }>;
  /** 佣金劈分明细（非空 → 内核事务内补一条 CRITICAL 审计 SPLIT_ORDER_COMMISSION）。 */
  commissionSplit: SplitCommissionAudit[];
  /**
   * 预存抵扣随拆搬移明细（非零 → 内核事务内补一条 CRITICAL 审计）。
   * 老的 PrepaymentTransaction(OFFSET) 流水仍按单指向源单，搬移只改订单侧的物化列，
   * 财务对账时要能一眼看到「这一单的抵扣被拆走了多少、去了哪张单」。
   */
  prepaymentOffsetSplit: { beforeCny: number; keptCny: number; movedCny: number } | null;
}> {

  // ── 1. 锁后读权威快照 + 重跑全部准入闸（fail-closed：预检放过的这里也要再拦一次）──
  const order = await loadOrderForSplit(tx, orderId);
  if (!order) throw new NotFoundError('订单不存在');
  const autoSplitRoomGroups = input.autoSplitRoomGroups === true;
  const assessment = await svc.assessOrderSplit(tx, order, input.passengerIds, {
    autoSplitRoomGroups,
  });
  if (assessment.blockers.length > 0) {
    throw new BadRequestError(`当前不能拆单：\n${assessment.blockers.join('\n')}`);
  }
  const movedIdSet = assessment.movedIdSet;
  const k = movedIdSet.size;
  const {
    movedShareCny,
    movedPaidCny,
    preTotalCny,
    prePaidCny,
    movedAdjustmentCny,
    targetTotalCny,
    prePrepaymentOffsetCny,
    movedPrepaymentOffsetCny,
  } = assessment;
  const keptPrepaymentOffsetCny = round2(prePrepaymentOffsetCny - movedPrepaymentOffsetCny);

  // ── 2. 显式指令校验（0.5 网格 / 整数由 schema 保证；这里校验行归属与上限）──
  // 2a. roomSplit：酒店行**与套餐住宿行**都收（套餐单没有独立 HOTEL 行，住宿盖章就在套餐行上）。
  const roomSplitByItem = new Map<string, number>();
  for (const entry of input.roomSplit ?? []) {
    if (roomSplitByItem.has(entry.itemId)) {
      throw new BadRequestError('roomSplit 中同一住宿行出现多次，请合并为一条');
    }
    const item = order.items.find((it) => it.id === entry.itemId);
    if (!item || (item.kind !== OrderItemKind.HOTEL && item.kind !== OrderItemKind.BUNDLE)) {
      throw new BadRequestError('roomSplit 指向的订单行不存在或不是住宿行，请刷新后重试');
    }
    const srcRooms = item.roomsBilled != null ? Number(item.roomsBilled) : null;
    if (srcRooms == null || srcRooms <= 0) {
      throw new BadRequestError(
        `住宿行「${item.description}」未记录计费房数（roomsBilled），请先保存分房表再拆分`,
      );
    }
    // 套餐住宿行的上限比酒店行少半间：套餐行永远是「劈成两条」（两侧都还有人、
    // 都还挂着自己的套餐），把间数全搬走会留下一条住着人却占 0 间房的套餐行。
    // 独立酒店行没有这个约束 —— 它可以整行搬走（moveHotel 的 WHOLE 分支）。
    const capRooms = item.kind === OrderItemKind.BUNDLE ? round2(srcRooms - 0.5) : srcRooms;
    if (entry.roomsBilledToMove > capRooms) {
      throw new BadRequestError(
        item.kind === OrderItemKind.BUNDLE
          ? `套餐住宿行「${item.description}」随拆搬走的间数（${entry.roomsBilledToMove}）超过上限：` +
            `该行计费 ${srcRooms} 间且两侧都还有客人，最多搬走 ${capRooms} 间。`
          : `住宿行「${item.description}」随拆搬走的间数（${entry.roomsBilledToMove}）超过该行计费房数（${srcRooms}）`,
      );
    }
    // 显式 0 = 「这一行整块留在源单」，与「缺省（不给这一行）」语义不同：
    // 缺省才走自动派生（编排路径），显式 0 是运营/编排的明确指令，必须照办。
    roomSplitByItem.set(entry.itemId, roundHalfGrid(entry.roomsBilledToMove));
  }

  // 2b. upgradeSplit：**一行一腿**（entry.toMove 直接给这一行搬几个升舱位）。
  //     旧形状（outboundToMove / returnToMove 两个字段一起发）继续兼容：按该行实际归属的
  //     航段取对应字段。航段判定走 determineFlightLegItems（按班次出发时刻），不再数下标 ——
  //     拆过一次的单里行序会变，数下标会把去程认成回程。
  //     未给的行不是「不搬升舱」，而是「按占座人头自动派生」—— 编排路径（no-show / 按人改期）
  //     根本不知道该填几个，硬要显式只会把它们逼进死路。
  const upgradeSplitByItem = new Map<string, number>();
  const { flightRows, returnItemId } = resolveSplitFlightLegs(order.items);
  // 升舱校验与升舱汇总共用同一份上下文：两个 Map 是**引用**传进去的，
  // 下面循环里往 upgradeSplitByItem 塞的值，2c 汇总时照样读得到。
  const preUpgradeCtx = buildSplitContext({
    movedIdSet,
    totalPax: order.passengers.length,
    occupancy: assessment.occupancy,
    roomSplitByItem,
    upgradeSplitByItem,
    autoDeriveRooms: autoSplitRoomGroups,
    movedUpgradeOutbound: 0,
    movedUpgradeReturn: 0,
    keptUpgradeOutbound: 0,
    keptUpgradeReturn: 0,
    splitPairToken: input.requestToken,
  });
  for (const entry of input.upgradeSplit ?? []) {
    if (upgradeSplitByItem.has(entry.itemId)) {
      throw new BadRequestError('upgradeSplit 中同一机票行出现多次，请合并为一条');
    }
    const item = flightRows.find((it) => it.id === entry.itemId);
    if (!item) {
      throw new BadRequestError('upgradeSplit 指向的订单行不存在或不是机票行，请刷新后重试');
    }
    const view = toSplitItemView(item);
    const count = readUpgradeCount(view.metadata);
    const legacyToMove = item.id === returnItemId ? entry.returnToMove : entry.outboundToMove;
    const toMove = Math.trunc(Number(entry.toMove ?? legacyToMove ?? 0));
    if (!Number.isFinite(toMove) || toMove < 0 || toMove > count) {
      throw new BadRequestError(
        `机票行「${item.description}」随拆搬走的升舱位（${toMove}）超出该行升舱人数（${count}）`,
      );
    }
    // 机票行的 quantity 是**占座数**（婴儿不占座），故两侧座位数按占座人头算 ——
    // 与 moveFlightLike 落库时用的是同一个 movedUnitsFor，校验与落库不会各算各的。
    const moveQty = movedUnitsFor(view, preUpgradeCtx);
    const keepQty = view.quantity - moveQty;
    if (toMove > moveQty || count - toMove > keepQty) {
      throw new BadRequestError(
        `机票行「${item.description}」的升舱位拆分与两侧座位数对不上：` +
          `拆出 ${moveQty} 座最多带 ${moveQty} 个升舱位，留守 ${keepQty} 座最多留 ${keepQty} 个。`,
      );
    }
    upgradeSplitByItem.set(entry.itemId, toMove);
  }

  // 2c. 升舱两侧分程汇总（套餐行 addOns 重建要用）：先按各机票行算出搬几个，再按航段归并。
  let movedUpgradeOutbound = 0;
  let movedUpgradeReturn = 0;
  let keptUpgradeOutbound = 0;
  let keptUpgradeReturn = 0;
  flightRows.forEach((item) => {
    const view = toSplitItemView(item);
    const count = readUpgradeCount(view.metadata);
    if (count <= 0) return;
    // 终态残骸行（回程过期作废 / 取消航段）整块留源单（planItemMove 判 NONE），
    // 升舱位自然一个不搬 —— 这里必须与落库口径一致，否则汇总会算出源单不存在的账。
    if (isTerminalLegItem(view.metadata)) {
      keptUpgradeOutbound += item.id === returnItemId ? 0 : count;
      keptUpgradeReturn += item.id === returnItemId ? count : 0;
      return;
    }
    const moveQty = movedUnitsFor(view, preUpgradeCtx);
    const keepQty = view.quantity - moveQty;
    const moved = moveQty >= view.quantity ? count : resolveUpgradeToMove(view, preUpgradeCtx, moveQty, keepQty);
    // 无班次的行（no-show 释放后 flightScheduleId 置空）归去程：它本就是去程行的残骸。
    if (item.id !== returnItemId) {
      movedUpgradeOutbound += moved;
      keptUpgradeOutbound += count - moved;
    } else {
      movedUpgradeReturn += moved;
      keptUpgradeReturn += count - moved;
    }
  });
  const splitCtx = buildSplitContext({
    movedIdSet,
    totalPax: order.passengers.length,
    occupancy: assessment.occupancy,
    roomSplitByItem,
    upgradeSplitByItem,
    // 编排路径（no-show / 按人改期）不传 roomSplit，房数一律按人头自动派生；
    // 手工拆单不自动派生（酒店行没填间数就整块留源单，与 v1 行为一致）。
    autoDeriveRooms: autoSplitRoomGroups,
    movedUpgradeOutbound,
    movedUpgradeReturn,
    keptUpgradeOutbound,
    keptUpgradeReturn,
    // 住宿行被劈成两个半间时，两侧写同一个配对键 —— 房控据此把跨单的两个半间配回一间。
    splitPairToken: input.requestToken,
  });

  // ── 3. 建新单：抄转正建单的事务内建单法，但**不重新定价不扣座**（行是搬/拆来的）──
  const nowIso = new Date().toISOString();
  const target = await tx.order.create({
    data: {
      orderNumber: targetOrderNumber,
      // 下单时刻原样继承源单（与下面佣金记录同口径）：财务/毛利报表按 order.createdAt 圈期，
      // 用默认的「now」会把一张 8 月的单拆出一张 9 月的新单 —— 8 月少算一半、9 月凭空多一半。
      // 拆单是同一笔业务的一分为二，不是新成交。updatedAt 照旧落当刻。
      createdAt: order.createdAt,
      userId: order.userId,
      agentId: order.agentId,
      guestName: order.guestName,
      guestPhone: order.guestPhone,
      guestEmail: order.guestEmail,
      status: order.status,
      currency: order.currency,
      // 占位金额：行搬完后统一按 movedShare 收敛（见步骤 7）。
      subtotal: new Prisma.Decimal(0),
      total: new Prisma.Decimal(0),
      contactName: order.contactName,
      contactPhone: order.contactPhone,
      contactEmail: order.contactEmail,
      // 开票位随人搬家（闸 6 已放开）：拆出去的人与留守的人票态相同，新单复制源单三个位、
      // 源单原样不动。班次开票额度按「被标记订单的乘客数」算，拆前后合计恒等（步骤 11 有断言）。
      outboundInvoiced: order.outboundInvoiced,
      returnInvoiced: order.returnInvoiced,
      systemInvoiced: order.systemInvoiced,
      // 两把锁跟随（闸 4-5 已放开）：源单锁着，新单也锁着。不写这两组字段 = 静默解锁，
      // 谁都能借「先拆一刀」绕开财务的结算价锁与收款复核锁。
      settlementLocked: order.settlementLocked,
      settlementLockedAt: order.settlementLockedAt,
      settlementLockedBy: order.settlementLockedBy,
      paymentsLocked: order.paymentsLocked,
      paymentsLockedAt: order.paymentsLockedAt,
      paymentsLockedBy: order.paymentsLockedBy,
      visaStatus: order.visaStatus,
      claimedById: order.claimedById,
      claimedAt: order.claimedAt,
      notes: [`由订单 ${order.orderNumber} 拆分创建`, order.notes?.trim() || null]
        .filter(Boolean)
        .join(' · '),
      noteHotel: order.noteHotel,
      noteVisa: order.noteVisa,
      notePayment: order.notePayment,
      noteSpecial: order.noteSpecial,
      expectedAmountCny: null,
      idempotencyKey: null,
      statusEvents: {
        create: {
          fromStatus: null,
          toStatus: order.status,
          actorUserId: actor.userId,
          reason: `由订单 ${order.orderNumber} 拆分创建（拆出 ${k} 人）`,
        },
      },
    },
    select: { id: true, orderNumber: true },
  });

  // ── 4. 按行搬/拆（unitPrice 全冻结；口径全在 split-move-strategies，内核只管落库）──
  // 拆前逐班次舱位数量账 + 升舱位账 + 房数账 + 成本账（守恒断言基准）。
  const preFlightQty = sumFlightQuantities(
    order.items.map((it) => ({
      kind: it.kind,
      flightScheduleId: it.flightScheduleId,
      flightCabin: it.flightCabin,
      quantity: it.quantity,
    })),
  );
  const preUpgradeQty = sumFlightUpgradeCounts(order.items);
  const preRoomsHalf = sumRoomsBilledHalves(order.items);
  const preCostCents = sumTotalCostCents(order.items);
  const fullyMovedItemIds = new Set<string>();
  const splitItemIdMap = new Map<string, string>(); // 源行 id → 新单对应行 id（拆分行）
  // 逐行的搬移决策留档：步骤 11 的「有占座人就必须有航段行」断言直接读它，不再回查数据库。
  const movePlans: Array<{ item: SplitItemView; plan: SplitMove }> = [];
  for (const item of order.items) {
    const view = toSplitItemView(item);
    const plan = planItemMove(view, splitCtx);
    movePlans.push({ item: view, plan });
    if (plan.mode === 'NONE') {
      // 「不动」也可能带一个就地补丁（目前只有：源单 no-show 名单裁掉被拆走的人）。
      // 走**只出 metadata 的硬白名单**，不走通用的 splitPatchToPrisma —— 后者能写数量/
      // 金额/成本/房数，而「不动的行不许动财务字段」正是守恒断言成立的前提，
      // 这个前提得由内核自己保证，不能只靠生产者自觉（类型上的 Pick 拦不住多带字段的变量）。
      const noneData = plan.update ? splitNoneUpdateToPrisma(plan.update) : null;
      if (noneData) {
        await tx.orderItem.update({ where: { id: item.id }, data: noneData });
      }
      continue;
    }
    if (plan.mode === 'WHOLE') {
      await tx.orderItem.update({
        where: { id: item.id },
        data: { orderId: target.id, ...splitPatchToPrisma(plan.update) },
      });
      fullyMovedItemIds.add(item.id);
      continue;
    }
    // SPLIT：源行就地改字段，新单建一条对应行（其余列原样复制，unitPrice 冻结）。
    await tx.orderItem.update({
      where: { id: item.id },
      data: splitPatchToPrisma(plan.keep),
    });
    const createdRow = await tx.orderItem.create({
      data: {
        orderId: target.id,
        kind: item.kind,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: item.amount,
        unitCostCny: item.unitCostCny,
        totalCostCny: item.totalCostCny,
        flightScheduleId: item.flightScheduleId,
        flightCabin: item.flightCabin,
        transferId: item.transferId,
        visaId: item.visaId,
        visaIntendedDate: item.visaIntendedDate,
        // 套餐/酒店行的住宿盖章原样跟走：两张单同酒店同房型同日期，房控把两个半间配回一间。
        hotelRoomTypeId: item.hotelRoomTypeId,
        randomStarTier: item.randomStarTier,
        hotelCheckIn: item.hotelCheckIn,
        hotelCheckOut: item.hotelCheckOut,
        roomsBilled: item.roomsBilled,
        // 既有 bug 修复：新建行此前不复制 bundleId —— 拆出来的套餐/机票行与套餐产品脱钩，
        // 新单改档（resolveChangeableBundleRow 要求 bundleId 非空）与套餐口径的佣金分类全失灵。
        bundleId: item.bundleId,
        idempotencyKey: null,
        ...splitPatchToPrisma(plan.move),
      },
      select: { id: true },
    });
    splitItemIdMap.set(item.id, createdRow.id);
  }

  // ── 5. 物理移乘客（保 id，护照图/送签进度全跟走）──
  const movedPax = await tx.passenger.updateMany({
    where: { id: { in: [...movedIdSet] }, orderId },
    data: { orderId: target.id },
  });
  if (movedPax.count !== k) {
    throw new Error(`拆单守恒断言失败：应移 ${k} 位乘客，实际移动 ${movedPax.count} 位（已回滚）`);
  }

  // ── 6. 分房表：拆出乘客所在房组整组搬到新单 ────────────────────────────────
  // 混合房组（一半走一半留）：手工拆单已被闸 15 拒在门外；编排路径（autoSplitRoomGroups）
  // 在这里按人劈成两个半组 —— 同酒店、同房型、同日期，两组 roomFraction 之和恒等于原组，
  // 房控把两个半间配回一间，房量分毫不动。
  const rawRoomAssignment = order.roomAssignment;
  const roomGroups = readRoomGroups(rawRoomAssignment).flatMap((group) => {
    if (group.passengerIds.length === 0) return [group];
    const movedInGroup = group.passengerIds.filter((id) => movedIdSet.has(id));
    if (movedInGroup.length === 0 || movedInGroup.length === group.passengerIds.length) {
      return [group];
    }
    const halves = splitMixedRoomGroup(group, movedIdSet, input.requestToken);
    return [
      { ...group, raw: halves.kept, passengerIds: group.passengerIds.filter((id) => !movedIdSet.has(id)) },
      { ...group, raw: halves.moved, passengerIds: movedInGroup },
    ];
  });
  let sourceRoomAssignmentUpdate: Prisma.InputJsonValue | undefined;
  let targetRoomAssignment: Prisma.InputJsonValue | undefined;
  if (roomGroups.length > 0) {
    const movedGroups: Record<string, unknown>[] = [];
    const keptGroups: Record<string, unknown>[] = [];
    for (const group of roomGroups) {
      const isMoved =
        group.passengerIds.length > 0 && group.passengerIds.every((id) => movedIdSet.has(id));
      if (!isMoved) {
        keptGroups.push(group.raw);
        continue;
      }
      // 房组归属行重定位：整行搬走 → 保留；被拆 → 指到新单对应行；指向留守行 → 搬不干净，400。
      const attributedTo =
        typeof group.raw.orderItemId === 'string' && group.raw.orderItemId.length > 0
          ? group.raw.orderItemId
          : null;
      if (attributedTo == null || fullyMovedItemIds.has(attributedTo)) {
        movedGroups.push(group.raw);
      } else if (splitItemIdMap.has(attributedTo)) {
        movedGroups.push({ ...group.raw, orderItemId: splitItemIdMap.get(attributedTo) });
      } else {
        throw new BadRequestError(
          `房组「${group.label ?? '未命名房组'}」挂在留在原订单的酒店行上。` +
            '请在 roomSplit 里把该行的对应间数一并拆走，或先在分房里调整房组归属。',
        );
      }
    }
    if (movedGroups.length > 0) {
      const base = readJsonObject(rawRoomAssignment);
      sourceRoomAssignmentUpdate = { ...base, roomGroups: keptGroups } as Prisma.InputJsonValue;
      targetRoomAssignment = { roomGroups: movedGroups } as Prisma.InputJsonValue;
    }
  }

  // ── 7. 平账行：两边各一条 SPLIT 差额行，把两侧 total 收敛到份额口径 ──
  //   份额（movedShare）是**应收**口径 = total + adjustmentCny，故先把随拆分摊的售后费
  //   （movedAdjustment）从份额里摘出来，剩下的才是新单的 total —— 否则售后费会被算两遍
  //   （一遍在 total 里、一遍在 adjustmentCny 里），客人凭空多欠一笔。
  //   新单 total == movedShare − movedAdjustment；源单 total == 拆前 total − 新单 total。
  //   正 → FEE、负 → DISCOUNT（与 buildSettlementTotalItem 同口径）；差额为 0 不生成行。
  const targetAgg = await tx.orderItem.aggregate({
    where: { orderId: target.id },
    _sum: { amount: true },
  });
  const targetItemsSum = round2(Number(targetAgg._sum.amount ?? 0));
  await createSplitBalanceItem(tx, {
    orderId: target.id,
    diffCny: round2(targetTotalCny - targetItemsSum),
    itemsSumCny: targetItemsSum,
    shareCny: targetTotalCny,
    splitFrom: order.orderNumber,
    splitTo: target.orderNumber,
  });
  const sourceTotalAfterCny = round2(preTotalCny - targetTotalCny);
  const keptAdjustmentCny = order.adjustmentCny - movedAdjustmentCny;
  const sourceAgg = await tx.orderItem.aggregate({
    where: { orderId },
    _sum: { amount: true },
  });
  const sourceItemsSum = round2(Number(sourceAgg._sum.amount ?? 0));
  await createSplitBalanceItem(tx, {
    orderId,
    diffCny: round2(sourceTotalAfterCny - sourceItemsSum),
    itemsSumCny: sourceItemsSum,
    shareCny: sourceTotalAfterCny,
    splitFrom: order.orderNumber,
    splitTo: target.orderNumber,
  });

  // ── 8. 钱：两侧金额收口 + SPLIT_OUT/SPLIT_IN 流水（仅记录，不动 adjustmentCny）──
  const sourcePaidAfterCny = round2(prePaidCny - movedPaidCny);
  const sourceLog = appendAdjustment(order.adjustments, {
    type: 'SPLIT_OUT',
    label: `拆单：拆出 ${k} 人至订单 ${target.orderNumber}`,
    amountCny: -movedShareCny,
    at: nowIso,
    by: actor.userId,
    note: [`随拆转移已收 ¥${movedPaidCny}`, input.note?.trim() || null]
      .filter(Boolean)
      .join('；'),
  });
  await tx.order.update({
    where: { id: orderId },
    data: {
      subtotal: new Prisma.Decimal(sourceTotalAfterCny),
      total: new Prisma.Decimal(sourceTotalAfterCny),
      paidAmount: new Prisma.Decimal(sourcePaidAfterCny),
      // 售后费按份额随拆分摊（闸 9 已放开）：两侧 Σ adjustmentCny 恒等，见步骤 11 断言。
      adjustmentCny: keptAdjustmentCny,
      // 预存抵扣同样按份额随拆搬（历史遗留列，现行系统恒为 0）：Σ 恒等，见步骤 11 断言。
      ...(prePrepaymentOffsetCny !== 0
        ? { prepaymentOffset: new Prisma.Decimal(keptPrepaymentOffsetCny) }
        : {}),
      adjustments: sourceLog,
      ...(sourceRoomAssignmentUpdate !== undefined
        ? { roomAssignment: sourceRoomAssignmentUpdate }
        : {}),
      statusEvents: {
        create: {
          fromStatus: order.status,
          toStatus: order.status,
          actorUserId: actor.userId,
          reason: `拆单：拆出 ${k} 人至订单 ${target.orderNumber}`,
        },
      },
    },
  });
  const targetLog = appendAdjustment(null, {
    type: 'SPLIT_IN',
    label: `由订单 ${order.orderNumber} 拆分创建（承接 ${k} 人份额）`,
    amountCny: movedShareCny,
    at: nowIso,
    by: actor.userId,
    note: [`承接已收 ¥${movedPaidCny}`, input.note?.trim() || null].filter(Boolean).join('；'),
  });
  await tx.order.update({
    where: { id: target.id },
    data: {
      subtotal: new Prisma.Decimal(targetTotalCny),
      total: new Prisma.Decimal(targetTotalCny),
      paidAmount: new Prisma.Decimal(movedPaidCny),
      adjustmentCny: movedAdjustmentCny,
      ...(prePrepaymentOffsetCny !== 0
        ? { prepaymentOffset: new Prisma.Decimal(movedPrepaymentOffsetCny) }
        : {}),
      adjustments: targetLog,
      ...(targetRoomAssignment !== undefined ? { roomAssignment: targetRoomAssignment } : {}),
    },
  });

  // 承接 Payment：movedPaid > 0 才建。核实状态继承来源——源单全部成功收款均已核实才算核实，
  // 钱没被财务对过流水，不因搬到新单就洗白（与占位单结转同哲学）。
  //
  // 成对落两条：新单一条**正额**承接行，源单一条**等额负额**对冲行。
  // 少了源单那条会造币：拆单只减 order.paidAmount，源单台账一行没动，于是源单下一次进 PAID
  // （_updateStatusWithinTx 的 `if (paymentsSum > currentPaid) paidAmount = paymentsSum`，
  // 本是给迟到的网关回调补记用的）就会把随拆转走的 movedPaid 重新灌回源单——同一笔钱在
  // 两张单上各算一次。对冲行的字段与口径与「多付处置」对冲行
  //（_recordOverpayDisposalPayment）逐字一致，不另起一套。
  if (movedPaidCny > 0) {
    const sourcePayments = await tx.payment.findMany({
      // 只看真实进账：对冲行金额为负、创建即视同已核实，算进来会把「财务还没对过流水」
      // 的账洗白（多次拆单时尤甚）。
      where: { orderId, status: PaymentStatus.SUCCEEDED, amount: { gt: 0 } },
      select: { verifiedAt: true },
    });
    const allVerified =
      sourcePayments.length > 0 && sourcePayments.every((p) => p.verifiedAt != null);
    await tx.payment.create({
      data: {
        orderId: target.id,
        method: PaymentMethod.BANK_CARD,
        amount: new Prisma.Decimal(movedPaidCny),
        status: PaymentStatus.SUCCEEDED,
        transactionId: null,
        idempotencyKey: `split:${order.id}:${input.requestToken}`,
        paidAt: new Date(),
        verifiedAt: allVerified ? new Date() : null,
        gatewayPayload: {
          splitFrom: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            movedCny: movedPaidCny,
            at: nowIso,
            by: actor.userId,
          },
          manual: false,
        } as Prisma.InputJsonValue,
      },
    });
    await tx.payment.create({
      data: {
        orderId,
        // 与配对的承接行同一支付方式，两条一眼看得出是一对（对冲行不是新钱进账，
        // 方式本身不承载业务含义）。
        method: PaymentMethod.BANK_CARD,
        amount: new Prisma.Decimal(-movedPaidCny),
        status: PaymentStatus.SUCCEEDED,
        transactionId: null,
        idempotencyKey: `split-out:${order.id}:${input.requestToken}`,
        // paidAt 留空 → 导出的「最近一笔成功收款」（按 paidAt 过滤排序）不会把对冲行误当收款。
        paidAt: null,
        // 内部记账（负额），不是新钱进账，创建即视同已核实，不进待核实队列。
        verifiedAt: new Date(),
        gatewayPayload: {
          source: 'split-transfer',
          targetOrderId: target.id,
          targetOrderNumber: target.orderNumber,
          requestToken: input.requestToken,
          amountCny: movedPaidCny,
          splitAt: nowIso,
          by: actor.userId,
          manual: false,
          // 收款区徽标：复用既有「已转出至 X」标注（serializePaymentRecord 已认这两个字段），
          // 不为拆单另造一个 label。
          transferredOut: true,
          transferredToOrderNumber: target.orderNumber,
        } as Prisma.InputJsonValue,
      },
    });
  }

  // ── 9. 履约：新单建自己的 PENDING 任务（源单任务留在原行，随行归属自然走）──
  const newTaskIds = await createFulfillmentTasks(tx, target.id);
  if (newTaskIds.length > 0) {
    await tx.fulfillmentTask.updateMany({
      where: { id: { in: newTaskIds } },
      data: { notes: `由订单 ${order.orderNumber} 拆分创建` },
    });
  }
  // 9b. 履约任务镜像（票务/签证/房/车的进度随人搬家，闸 12 已放开）：
  //   整行搬走的行连着它的任务一起过户（任务只挂 orderItemId），本来就带着原状态；
  //   被拆的行在新单上是**新建行**，createFulfillmentTasks 给它开的是 PENDING ——
  //   源单那段明明已确认出票 / 已送签 / 已订房，新单却一水儿「待处理」，各岗位会当成
  //   新活重办一遍。故把同类型任务的状态与业务字段从源行任务镜像过来（源单任务不动）。
  if (newTaskIds.length > 0 && splitItemIdMap.size > 0) {
    await mirrorTicketingTasksForSplit(tx, {
      newTaskIds,
      // 新单拆分行 → 源单对应行（splitItemIdMap 的反向索引）
      sourceItemIdByTargetItemId: new Map(
        [...splitItemIdMap.entries()].map(([sourceItemId, targetItemId]) => [
          targetItemId,
          sourceItemId,
        ]),
      ),
      splitNote: `由订单 ${order.orderNumber} 拆分创建`,
    });
  }
  await syncVisaTasksForOrder(tx, target.id, { userId: actor.userId, role: actor.role });
  // 9c. 签证任务承接：源单已办结（订单级已签证 + 乘客已送签）时新单复制的是「已签证」，
  //   建任务口径把它当客人自带签证而不建任务，9b 也就没得镜像 —— 拆出去的人从签证台消失。
  //   这里按「源单有活的签证任务 + 新单有非自备签乘客 + 新单还没有」补一条镜像任务。
  await carryVisaTaskForSplit(tx, {
    sourceOrderId: orderId,
    targetOrderId: target.id,
    targetOrderNumber: target.orderNumber,
    sourceOrderNumber: order.orderNumber,
    splitItemIdMap,
    splitNote: `由订单 ${order.orderNumber} 拆分创建`,
    actor: { userId: actor.userId, role: actor.role },
  });
  // 9d. 签证任务状态按**两侧各自的乘客**重派生（拆单审计 #5）：9b/9c 只把源任务的旧聚合状态
  //   原样镜像给新单，可任务级状态 = 该单非自备签乘客送签进度的最低档 —— 名单一分为二，
  //   两侧的最低档都可能变（两位已送签的人拆出去，新单该是「已送签」、源单剩下的人才是「待处理」）。
  //   送签进度随人搬家（乘客保 id 整行移动），这里只按各自名单把任务级状态派生回来；
  //   touch 用签证台同一口径（三档都可改写，CANCELLED/FAILED 永不复活）。
  //   一侧再没有要我方送签的人（全员自备签 / 全搬走）→ 不碰它的任务（无人可派生，留给任务有无同步）。
  for (const sideOrderId of [orderId, target.id]) {
    const ours = await tx.passenger.findMany({
      where: ourVisaPassengersWhere(sideOrderId),
      select: { visaSubmissionStatus: true },
    });
    if (ours.length === 0) continue;
    await rederiveVisaTaskStatus(tx, sideOrderId, {
      touch: DERIVABLE_TASK_STATUSES,
      statuses: ours.map((p) => p.visaSubmissionStatus),
    });
  }
  await syncOrderHasReturnLeg(tx, orderId);
  await syncOrderLegFlag(tx, orderId);
  await syncOrderHasReturnLeg(tx, target.id);
  await syncOrderLegFlag(tx, target.id);

  // ── 10. 新单操作费（与转正建单同口径：每单固定操作费）──
  await tx.orderCostItem.create({
    data: {
      orderId: target.id,
      category: 'OPERATION_FEE',
      amountCny: new Prisma.Decimal(OPERATION_FEE_CNY_PER_ORDER),
      note: '系统自动计提（每单固定操作费）',
    },
  });

  // ── 10b. 佣金劈分（闸 7 的 SPLIT 档：ACCRUED 且未挂结算单）─────────────────
  // 按两侧应收份额劈成两条：rate / chainDepth / productKind 原样（费率是与代理谈定的，
  // 不因拆单变），baseAmount 与 amount 同比例，留守侧取「原值 − 拆出侧」→ Σ 恒等。
  // 事务外补一条 CRITICAL 审计（SPLIT_ORDER_COMMISSION）：谁在什么时候把哪条佣金劈成了几条。
  const commissionSplit: SplitCommissionAudit[] = [];
  if (assessment.commission.mode === 'SPLIT') {
    const splittable = await tx.commissionRecord.findMany({
      where: {
        orderId,
        settlementId: null,
        OR: [
          { status: CommissionStatus.ACCRUED },
          // 负数 REVERSED 补偿行（退款/部分冲销的追回）也是「挂在这张单上、还没进结算单」
          // 的钱，同样按份额随拆走一半，否则拆出去那部分的追回永远算在源单头上。
          { status: CommissionStatus.REVERSED, amount: { lt: 0 } },
        ],
      },
      select: {
        id: true,
        agentId: true,
        productKind: true,
        baseAmount: true,
        rate: true,
        amount: true,
        chainDepth: true,
        status: true,
        createdAt: true,
      },
    });
    const commissionRatio =
      assessment.payableCny !== 0
        ? Math.min(1, Math.max(0, movedShareCny / assessment.payableCny))
        : order.passengers.length > 0
          ? k / order.passengers.length
          : 0;
    for (const rec of splittable) {
      const beforeAmount = round2(Number(rec.amount));
      const beforeBase = round2(Number(rec.baseAmount));
      const movedAmount = round2(beforeAmount * commissionRatio);
      const keptAmount = round2(beforeAmount - movedAmount);
      const movedBase = round2(beforeBase * commissionRatio);
      const keptBase = round2(beforeBase - movedBase);
      if (movedAmount === 0 && movedBase === 0) continue; // 劈出来是 0 → 不建空记录
      const created = await tx.commissionRecord.create({
        data: {
          agentId: rec.agentId,
          orderId: target.id,
          productKind: rec.productKind,
          baseAmount: new Prisma.Decimal(movedBase),
          rate: rec.rate,
          amount: new Prisma.Decimal(movedAmount),
          status: rec.status,
          chainDepth: rec.chainDepth,
          // 结算期次按 createdAt 划（settlements 的 generate 按 createdAt 圈本期 ACCRUED）：
          // 用默认的「now」会把一条 8 月计提的佣金劈出一条 9 月的记录，
          // 8 月那张结算单从此少了一半、9 月凭空多出一半。计提时刻原样继承。
          createdAt: rec.createdAt,
        },
        select: { id: true },
      });
      await tx.commissionRecord.update({
        where: { id: rec.id },
        data: {
          baseAmount: new Prisma.Decimal(keptBase),
          amount: new Prisma.Decimal(keptAmount),
        },
      });
      commissionSplit.push({
        commissionId: rec.id,
        agentId: rec.agentId,
        beforeAmountCny: beforeAmount,
        keptAmountCny: keptAmount,
        movedAmountCny: movedAmount,
        movedCommissionId: created.id,
        rate: Number(rec.rate),
        chainDepth: rec.chainDepth,
      });
    }
  }

  // ── 11. 守恒断言（不平整体回滚；宁可拆不成也不能拆出对不上的账）──
  const conservationSelect = {
    total: true,
    paidAmount: true,
    adjustmentCny: true,
    prepaymentOffset: true,
    outboundInvoiced: true,
    returnInvoiced: true,
    systemInvoiced: true,
    _count: { select: { passengers: true } },
  } as const;
  const [sourceAfter, targetAfter] = await Promise.all([
    tx.order.findUniqueOrThrow({ where: { id: orderId }, select: conservationSelect }),
    tx.order.findUniqueOrThrow({ where: { id: target.id }, select: conservationSelect }),
  ]);
  const EPS = 0.005;
  const totalAfter = Number(sourceAfter.total) + Number(targetAfter.total);
  if (Math.abs(totalAfter - preTotalCny) > EPS) {
    throw new Error(
      `拆单守恒断言失败：拆前 total ¥${preTotalCny}，拆后两单合计 ¥${round2(totalAfter)}（已回滚）`,
    );
  }
  const paidAfter = Number(sourceAfter.paidAmount) + Number(targetAfter.paidAmount);
  if (Math.abs(paidAfter - prePaidCny) > EPS) {
    throw new Error(
      `拆单守恒断言失败：拆前 paidAmount ¥${prePaidCny}，拆后两单合计 ¥${round2(paidAfter)}（已回滚）`,
    );
  }
  // 出票人数守恒（开票位随人搬家的兜底，与座位守恒同哲学）：某个开票维度上
  // 「被标记订单的乘客数」拆前后合计必须相等 —— 班次开票上限正是按这个数算的
  //（ticketing-cap.ts 的 countIssuedPassengers = Σ 被标记订单的乘客数），
  // 拆单一旦把它放大，就等于凭空多发一份开票额度、可能超发座位。
  const INVOICE_FLAGS = ['outboundInvoiced', 'returnInvoiced', 'systemInvoiced'] as const;
  const prePaxCount = order.passengers.length;
  for (const flag of INVOICE_FLAGS) {
    const before = order[flag] ? prePaxCount : 0;
    const after =
      (sourceAfter[flag] ? sourceAfter._count.passengers : 0) +
      (targetAfter[flag] ? targetAfter._count.passengers : 0);
    if (before !== after) {
      throw new Error(
        `拆单守恒断言失败：开票维度 ${flag} 拆前 ${before} 人、拆后两单合计 ${after} 人（已回滚）`,
      );
    }
  }
  // 售后费守恒（闸 9 放开后新增）：两侧 Σ adjustmentCny 必须等于拆前，
  // 否则「应收 = total + adjustmentCny」在两张单上加起来就不是拆前那笔钱。
  const adjustmentAfter = sourceAfter.adjustmentCny + targetAfter.adjustmentCny;
  if (adjustmentAfter !== order.adjustmentCny) {
    throw new Error(
      `拆单守恒断言失败：拆前售后费 ¥${order.adjustmentCny}，拆后两单合计 ¥${adjustmentAfter}（已回滚）`,
    );
  }
  // 预存抵扣守恒：它进「应付 − 已付」的每一条公式，两侧 Σ 必须等于拆前，
  // 否则两张单的尾款加起来不再等于拆前那笔钱。
  const prepaymentOffsetAfter =
    Number(sourceAfter.prepaymentOffset) + Number(targetAfter.prepaymentOffset);
  if (Math.abs(prepaymentOffsetAfter - prePrepaymentOffsetCny) > EPS) {
    throw new Error(
      `拆单守恒断言失败：拆前预存抵扣 ¥${prePrepaymentOffsetCny}，` +
        `拆后两单合计 ¥${round2(prepaymentOffsetAfter)}（已回滚）`,
    );
  }
  const itemsAfter = await tx.orderItem.findMany({
    where: { orderId: { in: [orderId, target.id] } },
    select: {
      kind: true,
      flightScheduleId: true,
      flightCabin: true,
      quantity: true,
      metadata: true,
      roomsBilled: true,
      totalCostCny: true,
    },
  });
  // ── 「有占座人就必须有航段行」（fail-closed）─────────────────────────────────
  //
  // 座位守恒只保证两侧 Σ 相等，它拦不住「整行搬到一侧、另一侧一座不剩」：
  // 2 大 1 婴的单拆「一位大人 + 婴儿」时，旧口径拿人头数 2 与机票行 quantity 2（占座数）比，
  // 判成整行搬走 —— 源单剩着一位客人却连一条航段行都没有，Σ 照样相等，账却已经错了。
  //
  // 两个刻意的豁免：
  //   · 终态残骸行（作废 / 取消航段）不计入 —— 它本来就整块留源单（planItemMove 判 NONE）；
  //   · **拆前就不齐**的单不管（活航段座位数 < 全员占座人数）：那是历史脏数据，
  //     拆单既不是成因也修不了它，拿这条断言拦住只会把这批单永久锁死。
  const liveFlightSeats = (items: ReadonlyArray<SplitConservationRow>): number =>
    items.reduce(
      (sum, it) =>
        it.kind === OrderItemKind.FLIGHT && !isTerminalLegItem(readJsonObject(it.metadata))
          ? sum + (it.quantity ?? 0)
          : sum,
      0,
    );
  const preLiveFlightSeats = liveFlightSeats(order.items);
  if (preLiveFlightSeats >= splitCtx.totalSeatPax && splitCtx.totalSeatPax > 0) {
    // 两侧各自的活航段座位数直接由**本次的搬移决策**推出（movePlans 在步骤 4 逐行记下），
    // 不再回查数据库：决策就是落库依据，二者必然一致，多一次往返反而多一个漂移点。
    let keptSeats = 0;
    let movedSeats = 0;
    for (const { item, plan } of movePlans) {
      if (item.kind !== OrderItemKind.FLIGHT || isTerminalLegItem(item.metadata)) continue;
      if (plan.mode === 'NONE') keptSeats += item.quantity;
      else if (plan.mode === 'WHOLE') movedSeats += item.quantity;
      else {
        keptSeats += plan.keep.quantity ?? item.quantity;
        movedSeats += plan.move.quantity ?? 0;
      }
    }
    const sides = [
      { label: '留守', seatPax: splitCtx.keptOccupancy.seatPax, seats: keptSeats },
      { label: '拆出', seatPax: splitCtx.movedOccupancy.seatPax, seats: movedSeats },
    ];
    for (const side of sides) {
      if (side.seatPax > 0 && side.seats <= 0) {
        throw new Error(
          `拆单守恒断言失败：${side.label}侧还有 ${side.seatPax} 位占座客人，` +
            '却一条有效航段行都没有（已回滚）',
        );
      }
    }
  }
  const postFlightQty = sumFlightQuantities(itemsAfter);
  for (const [key, preQty] of preFlightQty) {
    if ((postFlightQty.get(key) ?? 0) !== preQty) {
      throw new Error(
        `拆单守恒断言失败：班次舱位 ${key} 拆前 ${preQty} 座、拆后 ${postFlightQty.get(key) ?? 0} 座（已回滚）`,
      );
    }
  }
  for (const key of postFlightQty.keys()) {
    if (!preFlightQty.has(key)) {
      throw new Error(`拆单守恒断言失败：拆后凭空出现班次舱位 ${key}（已回滚）`);
    }
  }
  // 升舱位守恒（套餐单拆分新增）：升舱位对应真实商务舱库存，逐班次舱位 Σ 拆前后必须相等。
  const postUpgradeQty = sumFlightUpgradeCounts(itemsAfter);
  for (const key of new Set([...preUpgradeQty.keys(), ...postUpgradeQty.keys()])) {
    const before = preUpgradeQty.get(key) ?? 0;
    const after = postUpgradeQty.get(key) ?? 0;
    if (before !== after) {
      throw new Error(
        `拆单守恒断言失败：班次舱位 ${key} 升舱位拆前 ${before} 个、拆后 ${after} 个（已回滚）`,
      );
    }
  }
  // 房量守恒（套餐住宿行随拆按半间劈开后必查）：Σ roomsBilled 一分不能多、一分不能少，
  // 否则房控板会凭空多出/少掉房间。以「半间」整数比，避开 0.5 的浮点尾数。
  const postRoomsHalf = sumRoomsBilledHalves(itemsAfter);
  if (postRoomsHalf !== preRoomsHalf) {
    throw new Error(
      `拆单守恒断言失败：Σ 计费房数拆前 ${preRoomsHalf / 2} 间、拆后 ${postRoomsHalf / 2} 间（已回滚）`,
    );
  }
  // 成本守恒：拆单只搬成本不改成本，Σ totalCostCny 拆前后必须相等（毛利报表的底账）。
  const postCostCents = sumTotalCostCents(itemsAfter);
  if (postCostCents !== preCostCents) {
    throw new Error(
      `拆单守恒断言失败：Σ 成本拆前 ¥${preCostCents / 100}、拆后 ¥${postCostCents / 100}（已回滚）`,
    );
  }
  // 佣金守恒：劈分只改分配不改金额，两单 Σ amount 必须等于拆前。
  if (assessment.commission.mode === 'SPLIT') {
    const postCommission = await tx.commissionRecord.aggregate({
      where: {
        orderId: { in: [orderId, target.id] },
        status: {
          in: [
            CommissionStatus.ACCRUED,
            CommissionStatus.SETTLEMENT_REQUESTED,
            CommissionStatus.SETTLED,
          ],
        },
      },
      _sum: { amount: true },
    });
    const postCommissionCny = round2(Number(postCommission._sum.amount ?? 0));
    if (Math.abs(postCommissionCny - assessment.commission.amountCny) > EPS) {
      throw new Error(
        `拆单守恒断言失败：拆前佣金 ¥${assessment.commission.amountCny}、` +
          `拆后两单合计 ¥${postCommissionCny}（已回滚）`,
      );
    }
    // 待追回的负数补偿行同理：劈开只改分配不改金额，两单 Σ 必须等于拆前。
    const postReversal = await tx.commissionRecord.aggregate({
      where: {
        orderId: { in: [orderId, target.id] },
        status: CommissionStatus.REVERSED,
        settlementId: null,
        amount: { lt: 0 },
      },
      _sum: { amount: true },
    });
    const postReversalCny = round2(Number(postReversal._sum.amount ?? 0));
    if (Math.abs(postReversalCny - assessment.commission.reversalCny) > EPS) {
      throw new Error(
        `拆单守恒断言失败：拆前佣金冲销 ¥${assessment.commission.reversalCny}、` +
          `拆后两单合计 ¥${postReversalCny}（已回滚）`,
      );
    }
  }

  // ── 12. 拆单流水落库（快照存全员份额，事后复算依据）──
  await tx.orderSplitRecord.create({
    data: {
      sourceOrderId: orderId,
      targetOrderId: target.id,
      passengerCount: k,
      movedShareCny: new Prisma.Decimal(movedShareCny),
      movedPaidCny: new Prisma.Decimal(movedPaidCny),
      snapshot: {
        rows: assessment.allShareRows,
        movedPassengerIds: [...movedIdSet],
        preTotalCny,
        prePaidCny,
        movedShareCny,
        movedPaidCny,
        roomSplit: input.roomSplit ?? null,
        // 编排入参留档（只增字段）：按人改期的同 token 回放据此比对，见 reschedulePassengers。
        orchestration: input.orchestration ?? null,
      } as Prisma.InputJsonValue,
      requestToken: input.requestToken,
      createdById: actor.userId,
    },
  });

  // ── 13. 新单若已被承接款清账（PENDING_PAYMENT 且已收 ≥ 应收）→ 按既有口径推 PAID。
  //   其余状态/未结清不自动推进：拆后各自走既有支付/状态流转。
  await svc.advanceOrderToPaidIfClearedWithinTx(
    tx,
    target.id,
    { userId: actor.userId, role: actor.role, actorType: 'USER' },
    newTaskIds,
  );

  return {
    result: {
      sourceOrderId: orderId,
      sourceOrderNumber: order.orderNumber,
      targetOrderId: target.id,
      targetOrderNumber: target.orderNumber,
      movedShareCny,
      movedPaidCny,
      passengerCount: k,
      replayed: false,
    },
    preTotalCny,
    prePaidCny,
    sourceTotalAfterCny,
    targetTotalCny,
    sourcePaidAfterCny,
    allShareRows: assessment.allShareRows,
    passengerSummary: order.passengers.map((p) => ({
      id: p.id,
      name: p.chineseName?.trim() || p.fullName,
      moved: movedIdSet.has(p.id),
    })),
    commissionSplit,
    // 审计条件看的是**预存流水**（PrepaymentTransaction(OFFSET)）而不是 Order.prepaymentOffset
    // 那一列 —— 那一列没有任何生产代码写入、恒为 0，照它判等于这条审计永远不会触发。
    // 闸 10c 已在准入段把有流水的单拒在门外，这里留作最后一道防御：万一有路径绕过闸，
    // 至少财务能从审计里看到「这单的预存抵扣被拆过」。
    prepaymentOffsetSplit:
      prePrepaymentOffsetCny !== 0 || assessment.hasPrepaymentOffsetTxn
        ? {
            beforeCny: prePrepaymentOffsetCny,
            keptCny: keptPrepaymentOffsetCny,
            movedCny: movedPrepaymentOffsetCny,
          }
        : null,
  };
}

// ── 拆单 v1 · 模块级辅助（类型 / 加载 / 纯函数）─────────────────────────────

/** 拆单执行入参（路由 schema 与两条编排路径共用同一形状）。 */
export interface SplitOrderInput {
  passengerIds: string[];
  /** 显式指定某条酒店 / 套餐住宿行随拆搬走几间（0.5 网格）。 */
  roomSplit?: Array<{ itemId: string; roomsBilledToMove: number }>;
  /**
   * 显式指定某条机票行随拆搬走几个升舱位。新形状 = 一行一腿（toMove）；
   * outboundToMove / returnToMove 是旧形状，服务端按该行归属的航段取对应字段。
   */
  upgradeSplit?: Array<{
    itemId: string;
    toMove?: number;
    outboundToMove?: number;
    returnToMove?: number;
  }>;
  /**
   * 混合房组自动劈半（no-show / 按人改期编排传 true）。手工拆单默认 false：
   * 同房组闸照旧拒拆，让运营自己先在分房里把人分开。
   */
  autoSplitRoomGroups?: boolean;
  note?: string;
  /**
   * 编排上下文留档（按人改期传：目标航段行 / 目标班次 / 目标舱位 / 改期差价 / 每行搬几间房）。
   * 拆单本身不读它，只原样写进 OrderSplitRecord.snapshot.orchestration ——
   * 编排层拿同一个 requestToken 回放时据此比对入参：换了班次、换了费用或换了房数还沿用
   * 同一个 token，必须判 409，而不是静默回放上一轮拆出的那张单。
   */
  orchestration?: SplitOrchestrationSnapshot;
  requestToken: string;
}

/** 拆单执行/回放的统一响应形状。 */
export interface SplitOrderResult {
  sourceOrderId: string;
  sourceOrderNumber: string;
  targetOrderId: string;
  targetOrderNumber: string;
  movedShareCny: number;
  movedPaidCny: number;
  passengerCount: number;
  /** true = 幂等回放（同 requestToken 已拆过，本次未做任何写入）。 */
  replayed: boolean;
}

/** assessOrderSplit 的评估结果（preview 直接透出其中展示字段）。 */
export interface SplitAssessment {
  blockers: string[];
  /** 非阻断提示（如「本单已出票，票随人走」），只影响弹窗文案，不影响 eligible。 */
  warnings: string[];
  shares: Array<{ passengerId: string; fullName: string; shareCny: number }>;
  allShareRows: Array<{ passengerId: string; netCny: number; shareCny: number }>;
  movedShareCny: number;
  movedPaidCny: number;
  preTotalCny: number;
  prePaidCny: number;
  /** 应收总额 = total + adjustmentCny（份额的分母，Σ shares 恒等于它）。 */
  payableCny: number;
  /** 随拆转移的售后费用（改期费/换人费等按份额分摊的那一份）。 */
  movedAdjustmentCny: number;
  /** 新单 total = movedShare − movedAdjustment（售后费不重复计入应收）。 */
  targetTotalCny: number;
  /** 拆前的预存抵扣（Order.prepaymentOffset，历史遗留列，现行系统恒为 0）。 */
  prePrepaymentOffsetCny: number;
  /** 随拆搬到新单的预存抵扣（按份额比；留守 = 拆前 − 本值）。 */
  movedPrepaymentOffsetCny: number;
  /**
   * 本单挂着预存余额抵扣流水（PrepaymentTransaction(OFFSET)）吗。
   * 闸 10c 据此拒拆；执行段拿它当审计触发条件（那时已被闸拦下，纯属防御）。
   */
  hasPrepaymentOffsetTxn: boolean;
  hotelItems: SplitHotelItemView[];
  upgradeItems: SplitUpgradeItemView[];
  /**
   * 佣金处置：NONE=无佣金；SPLIT=按份额劈两条；BLOCKED=已进结算流程，拒拆。
   * reversalCny = 待追回的负数 REVERSED 补偿合计（≤0，尚未并入结算单），同样随拆按份额劈。
   */
  commission: { mode: 'NONE' | 'SPLIT' | 'BLOCKED'; amountCny: number; reversalCny: number };
  /** 有房组同时含拆出与留下的乘客（手工拆单 = 闸 15 拒拆；编排路径 = 自动劈半组）。 */
  roomGroupConflict: boolean;
  movedIdSet: Set<string>;
  /** 两侧人数/单住/自备签/升舱的解析结果（执行段直接拿去建 SplitContext）。 */
  occupancy: {
    movedOccupancy: SplitOccupancy;
    keptOccupancy: SplitOccupancy;
    movedSingleCount: number;
    keptSingleCount: number;
    movedSelfVisaCount: number;
    keptSelfVisaCount: number;
  };
}

/** 预检回给前端的酒店/套餐住宿行（运营据此填 roomSplit）。 */
export interface SplitHotelItemView {
  itemId: string;
  description: string;
  roomsBilled: number | null;
  /** 服务端按人头派生的建议间数（前端预填；不传 roomSplit 时编排路径也用这个数）。 */
  suggestedRoomsToMove: number | null;
  /** true = 这是套餐行自带的住宿盖章（套餐单没有独立 HOTEL 行）。 */
  isBundleStay: boolean;
}

/** 预检回给前端的升舱行（运营据此填 upgradeSplit）。 */
export interface SplitUpgradeItemView {
  itemId: string;
  leg: 'OUTBOUND' | 'RETURN';
  businessUpgradeCount: number;
  suggestedToMove: number;
  /** 这一行随拆搬走的座位数（= 该行升舱位的上限，前端据此夹输入框）。 */
  movedSeatPax: number;
  /** 这一行留在源单的座位数（= 留守侧升舱位的上限）。 */
  keptSeatPax: number;
}

/** 拆单要读的源单快照（预检与事务内共用同一份 loader，杜绝两处字段漂移）。 */
export async function loadOrderForSplit(db: Prisma.TransactionClient, orderId: string) {
  return db.order.findUnique({
    where: { id: orderId },
    include: {
      // orderBy + 班次时刻：升舱位的去程/回程归属靠 determineFlightLegItems 判定
      //（不能靠数组下标 —— Prisma 无 orderBy 时行序不保证，被 UPDATE 过的行还会跑到最后，
      // 于是「第一条 FLIGHT 行 = 去程」在拆过一次的单上会认错腿，升舱位归错航段）。
      items: {
        orderBy: { createdAt: 'asc' },
        include: { flightSchedule: { select: { departureTime: true, departureTz: true } } },
      },
      // 乘客不带 orderBy：与 ORDER_FULL_INCLUDE（详情页每人结算价表的数据源）同口径，
      // 保证「余数兜最后一位」兜到的与前端展示的是同一位乘客。
      passengers: {
        select: {
          id: true,
          fullName: true,
          chineseName: true,
          pnr: true,
          eticketNumber: true,
          // 套餐单拆分要按乘客现势重建人数快照（addOns）：
          //   passengerType → 成人/占座儿童/不占座婴儿；singleRoom → 单住间数；
          //   visaExempt → 自备签减免人数。
          // 分房混合房组劈半**不看性别**：两个半组写同一个 splitPairKey，房控据此配回一间。
          passengerType: true,
          visaExempt: true,
          singleRoom: true,
        },
      },
    },
  });
}
export type SplitSourceOrder = NonNullable<Awaited<ReturnType<typeof loadOrderForSplit>>>;

/** 防御式解析分房表房组（形状不符按无分房处理）；label 供人话文案。 */
export function readRoomGroups(
  roomAssignment: unknown,
): Array<{ raw: Record<string, unknown>; passengerIds: string[]; label: string | null }> {
  const groups = readJsonObject(roomAssignment).roomGroups;
  if (!Array.isArray(groups)) return [];
  return groups
    .filter((g): g is Record<string, unknown> => g != null && typeof g === 'object' && !Array.isArray(g))
    .map((g) => {
      const ids = Array.isArray(g.passengerIds)
        ? g.passengerIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
      const hotelName = typeof g.hotelName === 'string' && g.hotelName ? g.hotelName : null;
      const roomType = typeof g.roomType === 'string' && g.roomType ? g.roomType : null;
      const label = [hotelName, roomType].filter(Boolean).join(' · ') || null;
      return { raw: g, passengerIds: ids, label };
    });
}

/** 订单行 → 策略层认得的最小形状（Decimal / JSON 都在这里归一化，策略层只见普通数字）。 */
export function toSplitItemView(item: SplitSourceOrder['items'][number]): SplitItemView {
  return {
    id: item.id,
    kind: item.kind,
    description: item.description,
    quantity: item.quantity,
    unitPrice: Number(item.unitPrice),
    amount: Number(item.amount),
    totalCostCny: item.totalCostCny != null ? Number(item.totalCostCny) : null,
    roomsBilled: item.roomsBilled != null ? Number(item.roomsBilled) : null,
    passengerId: item.passengerId,
    metadata: readJsonObject(item.metadata),
  };
}

/** 策略层补丁 → Prisma 落库形状（数字转 Decimal；只带真正要改的列）。 */
export interface SplitPatchData {
  description?: string;
  quantity?: number;
  amount?: Prisma.Decimal;
  totalCostCny?: Prisma.Decimal | null;
  roomsBilled?: Prisma.Decimal | null;
  metadata?: Prisma.InputJsonValue;
}
/**
 * 「不动」决策（SplitMove.NONE）的落库形状 —— **硬白名单，只出 metadata**。
 *
 * 类型上 NONE 的 update 已经收成 `Pick<SplitRowPatch, 'metadata'>`，但 TypeScript 的结构类型
 * 挡不住一个多带了字段的变量被赋进来；而通用的 splitPatchToPrisma 能写数量/金额/成本/房数。
 * 「不动的行不许动财务字段」是拆单守恒断言成立的前提，这个前提必须由内核自己兜住，
 * 不能只靠生产者（split-move-strategies 里的各条策略）自觉。
 *
 * 返回 null = 补丁里没有 metadata，这一行一个字都不用改（连一次空写都省掉）。
 */
export function splitNoneUpdateToPrisma(
  update: Pick<SplitRowPatch, 'metadata'>,
): { metadata: Prisma.InputJsonValue } | null {
  if (update.metadata === undefined) return null;
  return { metadata: update.metadata as Prisma.InputJsonValue };
}

export function splitPatchToPrisma(patch: SplitRowPatch): SplitPatchData {
  const data: SplitPatchData = {};
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.quantity !== undefined) data.quantity = patch.quantity;
  if (patch.amount !== undefined) data.amount = new Prisma.Decimal(patch.amount);
  if (patch.totalCostCny !== undefined) {
    data.totalCostCny = patch.totalCostCny == null ? null : new Prisma.Decimal(patch.totalCostCny);
  }
  if (patch.roomsBilled !== undefined) {
    data.roomsBilled = patch.roomsBilled == null ? null : new Prisma.Decimal(patch.roomsBilled);
  }
  if (patch.metadata !== undefined) data.metadata = patch.metadata as Prisma.InputJsonValue;
  return data;
}

/** 佣金劈分的审计明细（事务外写 CRITICAL 审计用）。 */
export interface SplitCommissionAudit {
  commissionId: string;
  agentId: string;
  beforeAmountCny: number;
  keptAmountCny: number;
  movedAmountCny: number;
  movedCommissionId: string | null;
  rate: number;
  chainDepth: number;
}

/** 两侧人数解析结果（assessOrderSplit 产出，执行段与预检建议共用）。 */
export interface SplitOccupancyPair {
  movedOccupancy: SplitOccupancy;
  keptOccupancy: SplitOccupancy;
  movedSingleCount: number;
  keptSingleCount: number;
  movedSelfVisaCount: number;
  keptSelfVisaCount: number;
}

/**
 * 「建议值」用的上下文：无任何显式指令、允许自动派生。预检回显的 suggestedRoomsToMove /
 * suggestedToMove 与编排路径（不传 roomSplit/upgradeSplit）实际落库的数**同一函数算出来**，
 * 不存在「预检显示 0.5、执行搬了 1」的漂移。
 */
export function buildSplitSuggestionContext(input: {
  movedIdSet: Set<string>;
  totalPax: number;
  occupancy: SplitOccupancyPair;
}): SplitContext {
  return buildSplitContext({
    ...input,
    roomSplitByItem: new Map(),
    upgradeSplitByItem: new Map(),
    autoDeriveRooms: true,
    movedUpgradeOutbound: 0,
    movedUpgradeReturn: 0,
    keptUpgradeOutbound: 0,
    keptUpgradeReturn: 0,
    // 预检不落库 → 不写住宿行配对键（那是执行段的事）。
    splitPairToken: '',
  });
}

/** 拆单上下文装配（唯一入口，保证预检与执行看到同一套人数口径）。 */
export function buildSplitContext(input: {
  movedIdSet: Set<string>;
  totalPax: number;
  occupancy: SplitOccupancyPair;
  roomSplitByItem: Map<string, number>;
  upgradeSplitByItem: Map<string, number>;
  autoDeriveRooms: boolean;
  movedUpgradeOutbound: number;
  movedUpgradeReturn: number;
  keptUpgradeOutbound: number;
  keptUpgradeReturn: number;
  /** 住宿行劈半时两侧共用的配对键令牌（= requestToken）；预检建议上下文传空串。 */
  splitPairToken: string;
}): SplitContext {
  const { occupancy } = input;
  return {
    movedIdSet: input.movedIdSet,
    k: input.movedIdSet.size,
    totalPax: input.totalPax,
    movedSeatPax: occupancy.movedOccupancy.seatPax,
    totalSeatPax: occupancy.movedOccupancy.seatPax + occupancy.keptOccupancy.seatPax,
    movedOccupancy: occupancy.movedOccupancy,
    keptOccupancy: occupancy.keptOccupancy,
    movedSingleCount: occupancy.movedSingleCount,
    keptSingleCount: occupancy.keptSingleCount,
    movedSelfVisaCount: occupancy.movedSelfVisaCount,
    keptSelfVisaCount: occupancy.keptSelfVisaCount,
    roomSplitByItem: input.roomSplitByItem,
    upgradeSplitByItem: input.upgradeSplitByItem,
    movedUpgradeOutbound: input.movedUpgradeOutbound,
    movedUpgradeReturn: input.movedUpgradeReturn,
    keptUpgradeOutbound: input.keptUpgradeOutbound,
    keptUpgradeReturn: input.keptUpgradeReturn,
    autoDeriveRooms: input.autoDeriveRooms,
    splitPairToken: input.splitPairToken,
  };
}

/**
 * 拆单的航段归属：**按班次出发时刻**判去程/回程（determineFlightLegItems，全站唯一口径）。
 *
 * 不用「items 数组第一条 FLIGHT 行 = 去程」：Prisma 无 orderBy 时行序不保证，且被 UPDATE
 * 过的行（拆过一次 / 改过期）会跑到结果集末尾 —— 那条规则在拆过一次的单上会把去程认成回程，
 * 升舱位整块归错航段。无班次的行（no-show 释放后 flightScheduleId 置空）不归任何一腿，
 * 升舱汇总时按去程处理（它本来就是去程行被释放后的残骸）。
 */
export function resolveSplitFlightLegs(items: SplitSourceOrder['items']): {
  flightRows: SplitSourceOrder['items'];
  returnItemId: string | null;
} {
  const flightRows = items.filter((it) => it.kind === OrderItemKind.FLIGHT);
  const legs = determineFlightLegItems(flightRows);
  return { flightRows, returnItemId: legs.return?.id ?? null };
}

/** 带升舱位的机票行清单（预检回显 + 分程归属）。 */
export function collectSplitUpgradeItems(
  items: SplitSourceOrder['items'],
  ctx: SplitContext,
): SplitUpgradeItemView[] {
  const { flightRows, returnItemId } = resolveSplitFlightLegs(items);
  const out: SplitUpgradeItemView[] = [];
  flightRows.forEach((item) => {
    const view = toSplitItemView(item);
    const count = readUpgradeCount(view.metadata);
    if (count <= 0) return;
    // 终态残骸行不随拆（planItemMove 判 NONE），预检也不该把它列进「可拆升舱位」。
    if (isTerminalLegItem(view.metadata)) return;
    // 机票行两侧座位数按**占座人头**算（婴儿不占座），与落库同一个 movedUnitsFor。
    const moveQty = movedUnitsFor(view, ctx);
    const keepQty = view.quantity - moveQty;
    out.push({
      itemId: view.id,
      leg: view.id === returnItemId ? 'RETURN' : 'OUTBOUND',
      businessUpgradeCount: count,
      suggestedToMove: resolveUpgradeToMove(view, ctx, moveQty, keepQty),
      movedSeatPax: moveQty,
      keptSeatPax: keepQty,
    });
  });
  return out;
}

/**
 * 混合房组自动劈半（仅 no-show / 按人改期编排路径）：一个房组同时含拆出与留下的乘客时，
 * 按人头把它劈成两个房组 —— 同酒店、同房型、同日期，各自 roomFraction 按 0.5 网格分，
 * 两组之和恒等于原组（房控把两个半间配回一间，房量分毫不动）。
 *
 * 返回 { kept, moved }：留守组进源单分房表、拆出组进新单分房表。
 */
export function splitMixedRoomGroup(
  group: { raw: Record<string, unknown>; passengerIds: string[] },
  movedIdSet: ReadonlySet<string>,
  pairToken: string,
): { kept: Record<string, unknown>; moved: Record<string, unknown> } {
  const movedIds = group.passengerIds.filter((id) => movedIdSet.has(id));
  const keptIds = group.passengerIds.filter((id) => !movedIdSet.has(id));
  const rawFraction = group.raw.roomFraction == null ? 1 : Number(group.raw.roomFraction);
  const srcHalf = Math.max(1, Math.round((Number.isFinite(rawFraction) ? rawFraction : 1) * 2));
  let movedHalf = Math.round((srcHalf * movedIds.length) / group.passengerIds.length);
  movedHalf = Math.min(Math.max(movedHalf, 1), Math.max(1, srcHalf - 1));
  const keptHalf = srcHalf - movedHalf;
  // 房组 id 缺省时**不能**回落成固定字符串：一张单里两个无 id 的房组同时被劈开，
  // 两对半组会共用同一个 `group:<token>` 配对键，房控按 key 归并时会把四个半组
  // 错配成两间（甚至把 A 组的半间与 B 组的半间配成一间）。改用房组内乘客 id 排序后拼成的
  // 稳定派生值：同一房组每次算出来都一样，不同房组必然不同。
  const baseId =
    typeof group.raw.id === 'string' && group.raw.id
      ? group.raw.id
      : `pax:${[...group.passengerIds].sort().join('|')}`;
  // 配对键：两个半组写同一个 key，房控按 key 把它们配回一间（不看性别 —— 夫妻拼房
  // 被拆开后正是「一男一女各半间」，按性别配对会算成两间）。
  const splitPairKey = `${baseId}:${pairToken}`;
  return {
    kept: { ...group.raw, passengerIds: keptIds, roomFraction: keptHalf / 2, splitPairKey },
    moved: {
      ...group.raw,
      id: `${baseId}-split`,
      passengerIds: movedIds,
      roomFraction: movedHalf / 2,
      splitPairKey,
    },
  };
}

/**
 * 拆单履约任务镜像：把新单拆分行的履约任务对齐到源单对应行的**同类型**任务状态。
 *
 * 只对**被拆的行**做（整行搬走的行连任务一起过户，状态本来就没丢）；只镜像岗位关心的字段
 * （状态 / data / 备注 / 起止时间），不动源单任务。
 * 源行若没有活动的同类型任务（只有 CANCELLED 或压根没有）则不动新任务，让它维持 PENDING。
 *
 * 覆盖出票 / 签证 / 酒店 / 接送四类：拆之前签证已送签、房已订、车已派，拆出来的新单却
 * 一水儿的「待处理」，各岗位会当成新活重办一遍（签证岗为此报过重复送签）。
 * BUNDLE_COMPOSITE 不镜像 —— 它只是「这条套餐行要拆成哪几个子任务」的容器，无岗位语义。
 */
export const SPLIT_MIRRORED_TASK_TYPES = [
  FulfillmentType.FLIGHT_TICKETING,
  FulfillmentType.VISA_APPLICATION,
  FulfillmentType.HOTEL_BOOKING,
  FulfillmentType.TRANSFER_DISPATCH,
] as const;

export async function mirrorTicketingTasksForSplit(
  tx: Prisma.TransactionClient,
  input: {
    newTaskIds: string[];
    /** 新单拆分行 id → 源单对应行 id */
    sourceItemIdByTargetItemId: Map<string, string>;
    /** 新任务备注里保留的拆单来源标注 */
    splitNote: string;
  },
): Promise<void> {
  const newTasks = await tx.fulfillmentTask.findMany({
    where: { id: { in: input.newTaskIds }, type: { in: [...SPLIT_MIRRORED_TASK_TYPES] } },
    select: { id: true, orderItemId: true, type: true },
  });
  const pairs = newTasks
    .map((task) => ({
      taskId: task.id,
      type: task.type,
      sourceItemId: input.sourceItemIdByTargetItemId.get(task.orderItemId),
    }))
    .filter(
      (p): p is { taskId: string; type: FulfillmentType; sourceItemId: string } =>
        p.sourceItemId != null,
    );
  if (pairs.length === 0) return;

  const sourceTasks = await tx.fulfillmentTask.findMany({
    where: {
      orderItemId: { in: [...new Set(pairs.map((p) => p.sourceItemId))] },
      type: { in: [...SPLIT_MIRRORED_TASK_TYPES] },
      status: { not: FulfillmentStatus.CANCELLED },
    },
    select: {
      orderItemId: true,
      type: true,
      status: true,
      data: true,
      notes: true,
      startedAt: true,
      completedAt: true,
      // 签证任务的成本三字段 + 签证公司是**人均**口径：签证行按人头劈开，新单那份人均成本与源单同值，
      // 不镜像过去财务在新单上就对不出这笔签证费属于哪家（与 9c 承接口径一致）。
      visaUnitCostUsd: true,
      visaFxRate: true,
      visaUnitCostCny: true,
      visaSupplier: true,
    },
  });
  // 按 (源行, 类型) 索引：一条行上可能同时挂着出票与签证任务，只按行取会串类型。
  const sourceByKey = new Map(sourceTasks.map((t) => [`${t.orderItemId}|${t.type}`, t]));
  for (const pair of pairs) {
    const source = sourceByKey.get(`${pair.sourceItemId}|${pair.type}`);
    if (!source) continue;
    await tx.fulfillmentTask.update({
      where: { id: pair.taskId },
      data: {
        status: source.status,
        data: source.data === null ? Prisma.DbNull : (source.data as Prisma.InputJsonValue),
        notes: [source.notes?.trim() || null, input.splitNote].filter(Boolean).join(' · '),
        startedAt: source.startedAt,
        completedAt: source.completedAt,
        ...(pair.type === FulfillmentType.VISA_APPLICATION
          ? {
              visaUnitCostUsd: source.visaUnitCostUsd,
              visaFxRate: source.visaFxRate,
              visaUnitCostCny: source.visaUnitCostCny,
              visaSupplier: source.visaSupplier,
            }
          : {}),
      },
    });
  }
}

/**
 * 拆单平账行：使该侧 total 收敛到份额口径（正 → FEE、负 → DISCOUNT，
 * 与 buildSettlementTotalItem 同一正负口径）；差额为 0 不生成行。
 */
export async function createSplitBalanceItem(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    diffCny: number;
    itemsSumCny: number;
    shareCny: number;
    splitFrom: string;
    splitTo: string;
  },
): Promise<void> {
  if (input.diffCny === 0) return;
  const signed = `${input.diffCny > 0 ? '+' : '−'}¥${Math.abs(input.diffCny)}`;
  await tx.orderItem.create({
    data: {
      orderId: input.orderId,
      kind: input.diffCny > 0 ? OrderItemKind.FEE : OrderItemKind.DISCOUNT,
      description: `价格调整：拆单平账（${signed}）`,
      quantity: 1,
      unitPrice: new Prisma.Decimal(input.diffCny),
      amount: new Prisma.Decimal(input.diffCny),
      // 平账行是纯份额收敛（把行拆分的取整尾差与非人数行的份额补齐），无成本侧 → 显式落 0。
      totalCostCny: new Prisma.Decimal(0),
      metadata: {
        priceAdjustment: true,
        reasonCode: 'SPLIT',
        splitFrom: input.splitFrom,
        splitTo: input.splitTo,
        shareCny: input.shareCny,
        itemsSumCny: input.itemsSumCny,
      } as Prisma.InputJsonValue,
    },
  });
}

/** Prisma P2002（唯一约束冲突）且目标字段命中 fieldHint。 */
export function isUniqueViolation(err: unknown, fieldHint: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) return target.some((t) => String(t).includes(fieldHint));
  if (typeof target === 'string') return target.includes(fieldHint);
  return false;
}
