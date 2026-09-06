// 由 orders.service.ts 机械拆出（审查根因 R5，2026-09-06）：只搬代码、不改口径。
// 对外契约仍从 ../orders.service.js 取（facade 原名再导出）；OrderService 方法体在这里是
// `export function xxx(svc: OrderService, ...)`，方法里的 `this.` 一律写成 `svc.`——
// 跨组调用仍走 facade 实例，单测里对 OrderService 实例的 spy 行为不变。

import {
  AuditSeverity,
  CommissionStatus,
  OrderItemKind,
  OrderStatus,
  PrepaymentTxType,
  Prisma,
  type SettlementTier,
  UserRole,
} from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../lib/errors.js';
import { writeAudit } from '../../../lib/audit.js';
import { orderNeedsVisaTask } from '../visa-need.js';
import {
  assertOrderAcceptsFunds,
  FUNDS_DISPOSE_BLOCKED_STATUSES,
} from '../../../lib/funds-guard.js';
import { resolveBundleNights } from '../../products/bundle-nights.js';
import { getSettlementRate } from '../../settlement-rates/settlement-rates.service.js';
import { bundleRouteKey } from '../../products/bundle-route.js';
import {
  resolveAgentSettlementDiscount,
} from '../../settlement-discounts/settlement-discounts.service.js';
import {
  assertRandomTierFitWithinTx,
  checkHotelPhysicalFit,
  lockHotelBlockPeriodsWithinTx,
  randomStarTierLabel,
} from '../../hotel-control/hotel-control.service.js';
import { RANDOM_TIER_LEGACY_CITY_CODE } from '../../hotel-control/hotel-city.js';
import { resolveSelfVisaDeductCny } from '../../products/self-visa-deduct.js';
import { PRICE_ADJUSTMENT_CAP_CNY } from '../orders.schemas.js';
import type {
  AddGroundItemBody,
  ChangeOrderBundleBody,
  RescheduleItemHotelBody,
  SplitRoomGroupBody,
  SwapItemHotelBody,
} from '../orders.schemas.js';
import { FulfillmentStatus, FulfillmentType } from '@prisma/client';
import {
  assertHotelStaysFitWithinTx,
  assertRandomTierStaysFitWithinTx,
  buildStayNightDates,
  type BundleAddOnBreakdown,
  type BundleBusinessUpgradeSplit,
  type BundleOccupancy,
  computeBundleAddOn,
  computeBundleGroundTotal,
  computeBundleOperationFeeTotal,
  computeBundleRoomsCharged,
  MAX_STAY_NIGHTS,
  type ProspectiveHotelStay,
  resolveBundleBusinessUpgradeRate,
  resolveBundleHotelStamp,
  resolveBundleOccupancy,
  rewriteHotelStayDescription,
  toProspectiveOccupancy,
} from './bundle-pricing.js';
import { readJsonObject } from './leg-action-log.js';
import { deriveOrderDepartDate, orderSerializeRoleCtx, serializeOrder } from './read.js';
import {
  actorCan,
  addDaysToYmd,
  AGENT_SELF_EDIT_REASON,
  appendAdjustment,
  buildRoomSupplementItem,
  buildStarMismatchMessage,
  computeAgentSelfEditWindow,
  computeGroundItemAmounts,
  computeSwapHotelCostSnapshot,
  type DesignatedHotelStarMismatchOverride,
  formatDateOnly,
  formatMonthDay,
  isSettlementTierStarMismatch,
  ORDER_FULL_INCLUDE,
  RANDOM_TIER_INTERNAL_NO_CAP,
  resolveGroundItemUnitPrice,
  resolveRoomSupplementCost,
  type RoomCostSource,
  round2,
  SEAT_HOLDING_STATUSES,
  SETTLEMENT_TIER_STAR_RATING,
  zhStatus,
} from './shared.js';
import {
  bundleHotelNightsOf,
  computeSwapBundleCostSnapshot,
} from './item-cost-snapshot.js';
import { persistPassengerShares } from './passenger-shares.js';
import { createFulfillmentTasks, syncVisaTasksForOrder } from './visa-sync.js';
import type { OrderService } from '../orders.service.js';

/**
 * 换酒店：把订单里某条 HOTEL 行（或已盖章酒店的 BUNDLE 行）就地换到另一个房型/酒店，
 * 并（可选）加/减「换酒店差价」。
 *
 * 定价哲学（owner 批准 A+B）：价格默认冻结——客户已付的钱不变，换酒店只改「住哪」，
 * 绝不用新房型的 basePrice 重算 unitPrice/amount。差价是可选的人工调整，走与改期费/
 * 换人费相同的 adjustmentCny 机制，不填就是纯换房不改价。
 *
 * body：{ newHotelRoomTypeId, feeCny?, feeLabel?, note? }
 *   - orderItemId 必须属于本订单且 kind=HOTEL，或 kind=BUNDLE 且已盖章 hotelRoomTypeId。
 *   - newHotelRoomTypeId 必须存在、其酒店在架；与当前房型相同 → 400（无意义换房）。
 *
 * 「落位」（未落位随机单 → 具体酒店）走的是同一条通道：kind=HOTEL、无房型、randomStarTier
 * 非空的行（客人买的是「N 星随机」），本次把它落到具体酒店 —— 写 hotelRoomTypeId + 清
 * randomStarTier，占用从「未落位」转到该酒店。随机档余量 = 同星级酒店余量合计 − 未落位占用，
 * 故这一转：该酒店用房 +1、未落位占用 −1 ⇒ **随机档合计不变**（对账恒等）。此时：
 *   - 目标酒店星级（Hotel.starRating）不得低于随机档档次（降级交付 → 400；同级/升级放行）；
 *   - 目标酒店逐晚余量必须校验（落位就是往该酒店新增占房，没有"同酒店净不变"的豁免）；
 *   - 审计 before.hotelName = 档次名（「三星随机」），摘要渲染成「换酒店 三星随机 → XX酒店·房型」。
 *
 * 逐晚余量校验（仅当换到不同酒店时才做——同酒店换房型净房量不变，不受本单自身占用影响）：
 *   - block[i] > 0（该晚被房控周期管控）且 remaining[i] < 本行房间数 → 拒单，列出不足的夜晚。
 *   - block[i] === 0，或整段查询范围内一条周期都没有（hasBlock=false）→ 放行，计入
 *     untrackedNights（房控哲学：未配包房 = 未管控，不能拿来判"售罄"）。
 *
 * 单事务内：
 *   1. 更新该行 hotelRoomTypeId（HOTEL 行按创建期同款格式重建 description；BUNDLE 行的
 *      description 本就不含酒店名——由 serializer 实时联查 hotelRoomTypeId 得到，不用重建）。
 *      amount/unitPrice/quantity/hotelCheckIn/hotelCheckOut/roomsBilled 一律不动（冻结）。
 *   2. feeCny≠0 → order.adjustmentCny += feeCny，并 push 一条 adjustments 流水（HOTEL_SWAP_FEE）。
 *   3. Order.roomAssignment.roomGroups 里属于本行的组 → 改成新酒店名+新房型名：优先按
 *      orderItemId == 本行精确匹配（split-room-group / 分房保存写入的归属），无归属组回退
 *      (hotelName, roomType) 二元组匹配（人工填的其它酒店名不动——可能是老单据手填值，
 *      不该被这次换酒店误伤）。
 *
 * 返回值联查与 getOrder 同款富 include（hotelRoomType/bundle.hotelRoomType 等），确保响应
 * 里的 hotelName/roomTypeName 立即正确，调用方不用再刷一次详情。
 */
export async function swapItemHotel(
  svc: OrderService,
  orderId: string,
  itemId: string,
  input: SwapItemHotelBody,
  actor: { userId: string; role: UserRole; agentId?: string },
): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      orderItemId: string;
      before: {
        hotelRoomTypeId: string | null;
        hotelName: string | null;
        roomTypeName: string | null;
        unitCostCny: number | null;
        totalCostCny: number | null;
      };
      after: {
        hotelRoomTypeId: string;
        hotelName: string;
        roomTypeName: string;
        unitCostCny: number | null;
        totalCostCny: number | null;
      };
      feeCny: number;
      untrackedNights: string[];
      /** 非空 = 本次换酒店越过了「套餐档次 ↔ 酒店星级」闸（调用方据此另写一条 WARNING 审计）。 */
      starMismatchOverride: DesignatedHotelStarMismatchOverride | null;
    };
  }> {
  // 代理自助换酒店（下单当天、自家单）：过窗口闸后放行；客户与过期窗口一律 403。
  const isSelfService = actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF;
  if (isSelfService) {
    await svc.assertAgentSelfEditAllowed(orderId, actor);
  }
  // 自助通道差价恒 0（请求里填了也不认）：代理自助只改「住哪」，动钱一律走运营。
  const feeCny = isSelfService ? 0 : Math.trunc(input.feeCny ?? 0);

  const item = await prisma.orderItem.findUnique({
    where: { id: itemId },
    select: {
      id: true,
      orderId: true,
      kind: true,
      description: true,
      quantity: true,
      hotelRoomTypeId: true,
      randomStarTier: true,
      // BUNDLE 行的套餐归属：换入酒店的星级要与该套餐的结算档次比对（星级不匹配闸）。
      bundleId: true,
      hotelCheckIn: true,
      hotelCheckOut: true,
      roomsBilled: true,
      // 换酒店前的成本快照（审计 before / 保留 BUNDLE 行原值不动的依据）。
      unitCostCny: true,
      totalCostCny: true,
    },
  });
  if (!item || item.orderId !== orderId) {
    throw new NotFoundError('订单项不存在或不属于该订单');
  }
  // 「落位」：未落位随机单（kind=HOTEL、无房型、randomStarTier 非空）走同一条换酒店通道 ——
  // 落到具体酒店。占用随之从「未落位」转到该酒店（写 hotelRoomTypeId + 清 randomStarTier）。
  const isRandomPoolRow = item.kind === OrderItemKind.HOTEL && item.randomStarTier != null;
  const isHotelRow =
    item.kind === OrderItemKind.HOTEL ||
    (item.kind === OrderItemKind.BUNDLE && item.hotelRoomTypeId != null);
  if (!isHotelRow || (!item.hotelRoomTypeId && !isRandomPoolRow)) {
    throw new BadRequestError('该行不含酒店，无法换酒店');
  }
  if (item.hotelRoomTypeId && item.hotelRoomTypeId === input.newHotelRoomTypeId) {
    throw new BadRequestError('目标房型与当前房型相同，无需更换');
  }

  const [oldRoomType, newRoomType] = await Promise.all([
    item.hotelRoomTypeId
      ? prisma.hotelRoomType.findUnique({
          where: { id: item.hotelRoomTypeId },
          select: {
            id: true,
            name: true,
            hotelId: true,
            // 旧房型成本价 → BUNDLE 行按差额挪成本快照（把旧店那一项减出来，见 swapCost 处）。
            costPriceCny: true,
            // randomTierPlaceholder：原房型可能挂在随机档「占位酒店」上（伪落位行）——
            //   这种行业务上等同未落位随机单，落位时同样要吃「不许降级交付」的星级约束。
            // starRating：自助换酒店的同星级闸要拿它跟目标酒店比（见下方）。
            hotel: { select: { name: true, starRating: true, randomTierPlaceholder: true } },
          },
        })
      : Promise.resolve(null),
    prisma.hotelRoomType.findUnique({
      where: { id: input.newHotelRoomTypeId },
      select: {
        id: true,
        name: true,
        hotelId: true,
        // 新房型成本价 → 重打 HOTEL 行成本快照（每间每晚 × 晚数 × 房数）。
        costPriceCny: true,
        hotel: {
          select: {
            name: true,
            isActive: true,
            starRating: true,
            // 星级不匹配闸：国际五星与市区五星是两个档（另行报价），要分得开；
            // 占位酒店不是真房源，不参与本闸。
            intlFiveStar: true,
            randomTierPlaceholder: true,
          },
        },
      },
    }),
  ]);
  if (!newRoomType) throw new NotFoundError(`酒店房型 ${input.newHotelRoomTypeId} 不存在`);
  if (!newRoomType.hotel.isActive) throw new BadRequestError('酒店已下架');
  if (!isRandomPoolRow && !oldRoomType) {
    throw new NotFoundError('原酒店房型数据异常，无法换酒店');
  }
  // 随机单落位的星级约束：客人买的是「N 星随机」，落到低于该星级的酒店等于降级交付 ——
  // 拒绝；同级或更高（升级）放行。星级分类直接取酒店档案 Hotel.starRating。
  //
  // 两种「未落位」形态同吃这条约束（档次来源不同，语义完全一样）：
  //   a) 正规随机单 —— 档次取本行 randomStarTier；
  //   b) 伪落位行（房型挂在随机档占位酒店上）—— 档次取该占位酒店的 randomTierPlaceholder。
  const pendingTier = isRandomPoolRow
    ? item.randomStarTier!
    : (oldRoomType?.hotel.randomTierPlaceholder ?? null);
  if (pendingTier != null && newRoomType.hotel.starRating < pendingTier) {
    throw new BadRequestError(
      `${randomStarTierLabel(pendingTier)}只能落到 ${pendingTier} 星及以上的酒店（所选酒店为 ${newRoomType.hotel.starRating} 星）`,
    );
  }

  // ── 自助换酒店只许「同星级」（HIGH 修复）──────────────────────────────────
  // 差价被强制归 0 的前提是「换的是同一档住宿」。不比星级的话，自助通道就是一条免费升星的路：
  // 三星换五星，房量真的占过去、成本真的抬上去，我方一分钱收不到；反过来降星则是悄悄降级
  // 交付，客人买的档次没兑现，事后只能靠客诉才发现。
  // 现势星级来源：具体酒店行看当前酒店（含挂在占位酒店上的伪落位行）；未落位随机行看它买的档次。
  // 取不到现势星级（数据异常）一律按不符处理 —— 自助口子上宁可少放行。
  if (isSelfService) {
    const currentStar = isRandomPoolRow
      ? item.randomStarTier
      : (oldRoomType?.hotel.starRating ?? null);
    if (currentStar == null || newRoomType.hotel.starRating !== currentStar) {
      throw new BadRequestError('当日自助只能换同星级酒店，升降星请提交改单申请');
    }
  }

  // ── 套餐行的星级不匹配闸（口径与录单指定酒店同一份映射，见 SETTLEMENT_TIER_STAR_RATING）──
  // 套餐行的钱是按 Bundle.settlementTier 收的；售后把住宿换到别的档次而系统不知情，
  // 就等于「四星档的钱住三星店」从售后口子溜进来。两档口径，与录单指定酒店那道闸完全一致：
  //   · 运营（ADMIN/STAFF）→ 必须写明放行原因才过，放行写 WARNING 审计（谁放的、为什么放）；
  //   · 代理自助 → **硬拒**，没有放行原因这个口子。放行是「明知档次不符仍按此成交」的定价决定，
  //     代理自己填一行原因就能把四星档的单落到三星店，等于把定价权从我方手里拿走；
  //     真有这种需求走运营。请求体里带了 designatedHotelStarMismatchReason 也一律不认。
  // 已落位低星的存量单不追溯：本闸只在**本次换入**的酒店上判定。
  let starMismatchOverride: DesignatedHotelStarMismatchOverride | null = null;
  if (item.kind === OrderItemKind.BUNDLE && item.bundleId && newRoomType.hotel.randomTierPlaceholder == null) {
    const swapBundle = await prisma.bundle.findUnique({
      where: { id: item.bundleId },
      select: { id: true, name: true, settlementTier: true },
    });
    if (
      swapBundle?.settlementTier != null &&
      isSettlementTierStarMismatch(swapBundle.settlementTier, newRoomType.hotel)
    ) {
      // 代理自助：硬拒，放行原因一概不认（越权定价的口子对外身份一律不开）。
      if (isSelfService) {
        throw new BadRequestError(
          `${buildStarMismatchMessage(swapBundle.settlementTier, newRoomType.hotel)}。` +
            '套餐档次与酒店星级不符，请联系运营处理。',
        );
      }
      const reason = input.designatedHotelStarMismatchReason?.trim();
      if (!reason) {
        throw new BadRequestError(
          `${buildStarMismatchMessage(swapBundle.settlementTier, newRoomType.hotel)}。` +
            '如确需换到该酒店，请填写放行原因（将留档备查）。',
        );
      }
      starMismatchOverride = {
        bundleId: swapBundle.id,
        bundleName: swapBundle.name ?? null,
        bundleTier: swapBundle.settlementTier,
        bundleTierStar: SETTLEMENT_TIER_STAR_RATING[swapBundle.settlementTier],
        hotelRoomTypeId: newRoomType.id,
        hotelId: newRoomType.hotelId,
        hotelName: newRoomType.hotel.name,
        hotelStarRating: newRoomType.hotel.starRating ?? null,
        hotelIntlFiveStar: newRoomType.hotel.intlFiveStar === true,
        reason,
      };
    }
  }

  // ── 逐晚余量校验（仅跨酒店换房时才需要；同酒店换房型净房量不变，不受本单占用影响）──
  const roomsBilled = item.roomsBilled != null ? Number(item.roomsBilled) : 1;

  // 套餐 HOTEL 组件的晚数合计 —— BUNDLE 行按差额挪成本快照时要用（见下方 bundleSwapCost）。
  // 单独取一次：上面星级闸里那次 bundle 查询带条件（占位酒店不查），成本这边不能跟着漏。
  const swapBundleComponents =
    item.kind === OrderItemKind.BUNDLE && item.bundleId
      ? (
          await prisma.bundle.findUnique({
            where: { id: item.bundleId },
            select: { items: true },
          })
        )?.items
      : null;

  // ── HOTEL 行成本重打快照（Task B）：按新房型成本价 × 晚数(quantity) × 房数(roomsBilled)，
  // 口径对齐建单时的 HOTEL 行快照公式。新房型无成本价 → null（真缺数据，如实报缺）。
  const beforeUnitCostCny = item.unitCostCny != null ? Number(item.unitCostCny.toString()) : null;
  const beforeTotalCostCny = item.totalCostCny != null ? Number(item.totalCostCny.toString()) : null;
  const swapCost =
    item.kind === OrderItemKind.HOTEL
      ? computeSwapHotelCostSnapshot({
          newCostPriceCny:
            newRoomType.costPriceCny != null ? Number(newRoomType.costPriceCny.toString()) : null,
          nights: item.quantity,
          rooms: roomsBilled,
        })
      : null;

  // ── BUNDLE 行成本快照跟着换店走（按差额挪住宿那一项）────────────────────────
  // 套餐行的快照是整包地面成本（住宿 + 签证 + 用车，建单时按组件求和落库）。换酒店只换了
  // 住宿那一项，所以按差额挪：before + (新每晚成本 − 旧每晚成本) × 套餐 HOTEL 组件晚数 × 房数。
  // 不整包重算 —— 换酒店流程手上没有办签人数等建单口径参数，硬算会把另外几项算错。
  // 差额算不出来（建单时本就没算出整包成本 / 新旧任一房型没录成本价）→ 快照转 NULL：
  // 换完店还留着旧店那个数，等于让报表拿一个已经不成立的成本继续算毛利。
  const bundleSwapCost =
    item.kind === OrderItemKind.BUNDLE
      ? computeSwapBundleCostSnapshot({
          beforeTotalCostCny,
          oldCostPriceCny:
            oldRoomType?.costPriceCny != null ? Number(oldRoomType.costPriceCny.toString()) : null,
          newCostPriceCny:
            newRoomType.costPriceCny != null ? Number(newRoomType.costPriceCny.toString()) : null,
          nights: bundleHotelNightsOf(swapBundleComponents),
          rooms: roomsBilled,
        })
      : null;
  /** BUNDLE 行是否要改写 totalCostCny（含改写成 NULL 的情形，故不能只看 bundleSwapCost 是否为空）。 */
  const writeBundleCost = item.kind === OrderItemKind.BUNDLE && beforeTotalCostCny != null;

  // 换酒店前后的成本快照（审计留痕）。
  const afterUnitCostCny = swapCost ? swapCost.unitCostCny : beforeUnitCostCny;
  const afterTotalCostCny = swapCost
    ? swapCost.totalCostCny
    : writeBundleCost
      ? bundleSwapCost
      : beforeTotalCostCny;
  const nightDates =
    item.hotelCheckIn && item.hotelCheckOut
      ? buildStayNightDates(item.hotelCheckIn, item.hotelCheckOut)
      : [];
  // 是否需要校验目标酒店房量：随机单落位一律要校验（落位就是往目标酒店新增占房）；
  // 具体酒店行只在跨酒店时校验（同酒店换房型净房量不变）。真正的判定在事务内做（见下方）。
  const needsHotelFitCheck =
    (isRandomPoolRow || oldRoomType!.hotelId !== newRoomType.hotelId) && nightDates.length > 0;

  // ── HOTEL 行按创建期同款格式重建 description；BUNDLE 行不含酒店名，不用重建 ──
  let newDescription = item.description;
  if (item.kind === OrderItemKind.HOTEL && item.hotelCheckIn && item.hotelCheckOut) {
    const roomsLabel = Number.isInteger(roomsBilled) ? String(roomsBilled) : roomsBilled.toFixed(1);
    // 晚数以住宿区间为准（nightDates 就是 [checkIn, checkOut) 逐晚展开），不用 item.quantity ——
    // quantity 是**计价乘数**，酒店改期按「行价冻结」不动它，改完期后它可能已不等于真实晚数；
    // 拿它重建描述会把旧晚数又写回去。区间异常（nightDates 为空）时才回退到 quantity。
    const nightsLabel = nightDates.length > 0 ? nightDates.length : item.quantity;
    newDescription =
      `${newRoomType.hotel.name} · ${newRoomType.name} · ` +
      `${formatDateOnly(item.hotelCheckIn)}~${formatDateOnly(item.hotelCheckOut)} · ` +
      `${nightsLabel}晚 × ${roomsLabel}间`;
  }

  const scratch = await prisma.$transaction(async (tx) => {
    // Order 行锁（HIGH 修复）：换酒店要读-改-写 adjustmentCny/adjustments（差价流水），
    // 与换人/改期/到账入账是同一份读-改-写。此前这里是全库唯一不加订单行锁的写路径 ——
    // 并发的「换酒店 +¥300」与「换人费 +¥500」会互相覆盖（lost update，少收一笔）。
    // 现在与其余写路径一律先 FOR UPDATE，同一订单上的资金调整严格串行。
    const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
    `;
    if (lockRows.length === 0) throw new NotFoundError('订单不存在');

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        deletedAt: true,
        adjustmentCny: true,
        adjustments: true,
        roomAssignment: true,
        total: true,
        // 自助窗口的锁内复查要用（口径同入口 assertAgentSelfEditAllowed）。
        createdAt: true,
        outboundInvoiced: true,
        returnInvoiced: true,
        systemInvoiced: true,
        settlementLocked: true,
      },
    });
    if (!order) throw new NotFoundError('订单不存在');

    // ── 自助窗口锁内复查（L3）───────────────────────────────────────────────
    // 入口那次判定是锁外快照：从判完到拿锁之间订单可能已出票/已开票/已锁结算价，或者
    // 跨过了北京业务日 24:00。拿刚锁住的这一行重跑同一份纯函数，报错文案也是同一句。
    if (actor.role === UserRole.AGENT) {
      const window = computeAgentSelfEditWindow(order);
      if (!window.open) {
        throw new ForbiddenError(window.reason ?? AGENT_SELF_EDIT_REASON.NEXT_DAY);
      }
    }

    // ── 有效订单守卫（HIGH 修复）：与改期 / 升舱同款双闸 ────────────────────
    // 换酒店会往目标酒店新增占房、并通过 feeCny 改 adjustmentCny（客户应付）。在已取消 /
    // 已退款 / 超时 / 回收站单上换酒店 → 死单凭空占住真实房量，且长出一笔并不存在的「欠款」。
    // 读的是刚 FOR UPDATE 锁住的那一行，与并发状态流转严格串行。
    if (order.deletedAt) {
      throw new BadRequestError('订单在回收站（已软删），不可换酒店；如需操作请先恢复');
    }
    if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
      throw new BadRequestError(
        `订单当前状态（${zhStatus(order.status)}）不可换酒店：仅占座中的有效订单可换酒店（已取消/已退款/超时订单请勿换酒店）`,
      );
    }

    // ── 0b. 目标酒店逐晚房量前瞻闸（事务内互斥版）────────────────────────────
    // 物理房间口径（口径同下单闸 / 销控板看板）：把本单要挪进目标酒店的占房塞进目标酒店当晚的
    // 性别桶里重算物理间数 —— 床位口径看不见「异性不能拼一间」这一维。
    // 必须在事务内、且先锁目标酒店该区间的包房周期行：判定与占房落库（下方第 1 步写
    // hotelRoomTypeId）之间不能有窗口，否则两笔并发换酒店会各自读到「还剩 1 间」的旧快照双双通过。
    // excludeOrderItemIds（行级排除）：只排本次要挪走的这一行 —— 它当前挂在原酒店，理论上
    // 不该被目标酒店的占房查询选中，显式排除是防御同酒店异常数据被算两遍。同单**另一条行**
    // 在目标酒店的占用是真实存量，必须照常计入（旧版 excludeOrderId 把整单排掉 → 放行超卖）。
    // 拼房单（roomsBilled=0.5）要按性别配对判定 → 取本单出行人性别（口径同房控 pickSoloGender）。
    let untrackedNights: string[] = [];
    if (needsHotelFitCheck) {
      await lockHotelBlockPeriodsWithinTx(tx, newRoomType.hotelId, nightDates);
      const swapPassengers = await tx.passenger.findMany({
        where: { orderId },
        select: { gender: true },
      });
      const fit = await checkHotelPhysicalFit(
        newRoomType.hotelId,
        nightDates,
        toProspectiveOccupancy(
          roomsBilled,
          swapPassengers.map((p) => ({ gender: p.gender ?? undefined })),
        ),
        { excludeOrderItemIds: [item.id] },
        tx,
      );
      if (fit.hasBlock) {
        untrackedNights = nightDates.filter((_, i) => fit.block[i] === 0);
        if (fit.violations.length > 0) {
          const detail = fit.violations
            .map(
              (v) =>
                `目标酒店 ${formatMonthDay(new Date(`${v.date}T00:00:00.000Z`))}实际房间不足（包房 ${v.block} 间，换过去后需 ${v.physicalUsed} 间）`,
            )
            .join('；');
          throw new BadRequestError(detail);
        }
      } else {
        // 整段查询范围内一条包房周期都没有 → 全部夜晚视为未管控（房控哲学：未配包房≠售罄）
        untrackedNights = [...nightDates];
      }
    }

    // ── 0. 减价不能把应付冲成负数（HIGH 修复）──
    // 减价（feeCny<0）是合法操作（"我方缺房挪客不变价"里客人主动少收），但没有下限就能把
    // effectivePayable（= total + adjustmentCny，客户实际应付）冲到任意负数，系统账面上就
    // 变成"欠客户钱"，而这笔"欠款"并非真实退款（没有对应的 Refund/退款流水）。
    // 只挡「减到应付为负」这一种；加价（feeCny>0）不受限（已有 schema 层 ±10 万绝对上限）。
    if (feeCny < 0) {
      const currentPayable = round2(Number(order.total.toString()) + order.adjustmentCny);
      const newPayable = round2(currentPayable + feeCny);
      if (newPayable < 0) {
        throw new BadRequestError('减价金额不能超过当前应付（最多减到应付为 0）');
      }
    }

    // ── 1. 更新订单行（只换房型引用 + 重建 description；金额/数量/日期/间数一律冻结）──
    // 成本快照按新房型重打（仅 HOTEL 行；售价/金额一个字不动，只改成本侧的毛利真账）。
    await tx.orderItem.update({
      where: { id: item.id },
      data: {
        hotelRoomTypeId: newRoomType.id,
        // 随机单落位：清空随机档标记 —— 占用从「未落位」转到该酒店，随机档合计不变
        randomStarTier: null,
        description: newDescription,
        ...(swapCost
          ? {
              unitCostCny:
                swapCost.unitCostCny != null ? new Prisma.Decimal(swapCost.unitCostCny) : null,
              totalCostCny:
                swapCost.totalCostCny != null ? new Prisma.Decimal(swapCost.totalCostCny) : null,
            }
          : {}),
        // BUNDLE 行：只改整包成本（unitCostCny 建单时就没写，这里也不写）。
        ...(writeBundleCost
          ? {
              totalCostCny: bundleSwapCost != null ? new Prisma.Decimal(bundleSwapCost) : null,
            }
          : {}),
      },
    });

    // ── 2. 可选换酒店差价（adjustmentCny + adjustments 流水，与改期费同机制）──
    if (feeCny !== 0) {
      const log = appendAdjustment(order.adjustments, {
        type: 'HOTEL_SWAP_FEE',
        label: input.feeLabel || '换酒店差价',
        amountCny: feeCny,
        at: new Date().toISOString(),
        by: actor.userId,
        note: input.note,
      });
      await tx.order.update({
        where: { id: orderId },
        data: { adjustmentCny: order.adjustmentCny + feeCny, adjustments: log },
      });
    }

    // ── 3. 分房表里属于本行的组 → 改名到新酒店+新房型（HIGH 修复 + 归属精确匹配）──
    // 优先按 orderItemId == 本行精确匹配（split-room-group / 分房保存写入的归属字段）——
    // 这是数据模型上百分百的"这组人就是这一行的客人"，跨酒店/同酒店多行都不会误伤。
    // 无任何组归属到本行时回退旧口径：(hotelName, roomType) 二元组匹配 —— 一个订单有 2 条
    // HOTEL 行都住"同一家酒店"（不同房型/不同批客人）时，只换其中一行，二元组比单凭酒店名
    // 更贴近"这条订单行"的身份；已归属到**其它行**的组绝不参与二元组匹配（名字撞上也不改）。
    // 同时把 roomType 也一并改写到新房型名（旧版只改 hotelName，遗留一个在目标酒店根本
    // 不存在的旧房型名，分房表看着货不对板）。
    // 随机单落位（无 oldRoomType）没有「旧酒店名」可匹配 → 只走 orderItemId 精确匹配，
    // 绝不拿 undefined 去比对分房组的 hotelName（那会把所有没填酒店名的组一并误改）。
    const roomAssignmentRaw = order.roomAssignment;
    if (roomAssignmentRaw && typeof roomAssignmentRaw === 'object' && !Array.isArray(roomAssignmentRaw)) {
      const groups = (roomAssignmentRaw as { roomGroups?: unknown }).roomGroups;
      if (Array.isArray(groups)) {
        const groupItemId = (g: unknown): string | null => {
          if (g == null || typeof g !== 'object') return null;
          const v = (g as { orderItemId?: unknown }).orderItemId;
          return typeof v === 'string' && v.length > 0 ? v : null;
        };
        const hasOwnAttribution = groups.some((g) => groupItemId(g) === item.id);
        let changed = false;
        const newGroups = groups.map((g) => {
          if (g == null || typeof g !== 'object') return g;
          const attributedTo = groupItemId(g);
          const matched = hasOwnAttribution
            ? attributedTo === item.id
            : oldRoomType != null &&
              attributedTo == null &&
              (g as { hotelName?: unknown }).hotelName === oldRoomType.hotel.name &&
              (g as { roomType?: unknown }).roomType === oldRoomType.name;
          if (matched) {
            changed = true;
            return {
              ...(g as Record<string, unknown>),
              hotelName: newRoomType.hotel.name,
              roomType: newRoomType.name,
            };
          }
          return g;
        });
        if (changed) {
          await tx.order.update({
            where: { id: orderId },
            data: {
              roomAssignment: {
                ...(roomAssignmentRaw as Record<string, unknown>),
                roomGroups: newGroups,
              } as Prisma.InputJsonValue,
            },
          });
        }
      }
    }

    // 按人份额落库（R1）：换酒店差价进了 adjustmentCny，每人份额随之重算。
    await persistPassengerShares(tx, orderId);
    return { orderNumber: order.orderNumber, untrackedNights };
  });

  // ── 返回值：与 getOrder 同款富联查，确保 hotelName/roomTypeName 立即正确 ──
  const finalOrder = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      items: {
        include: {
          hotelRoomType: {
            select: { name: true, hotel: { select: { name: true, randomTierPlaceholder: true } } },
          },
          flightSchedule: {
            select: {
              departureTime: true,
              arrivalTime: true,
              // 当地时区：行程单/订单详情的时刻必须按它折算，否则显示的是 UTC 分量
              departureTz: true,
              arrivalTz: true,
              flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
            },
          },
          visa: { select: { visaName: true, country: true, destinationCountry: true, stayDays: true } },
          transfer: { select: { name: true } },
          bundle: {
            select: {
              name: true,
              serviceNotes: true,
              items: true,
              infantPriceCny: true,
              childSeatDiscountCnyPerPerson: true,
              hotelRoomTypeId: true,
              hotelRoomType: { select: { name: true, hotel: { select: { name: true } } } },
            },
          },
        },
      },
      passengers: true,
      payments: true,
      refunds: true,
      statusEvents: { orderBy: { createdAt: 'asc' } },
      agent: { select: { id: true, companyName: true, contactName: true, settlementMode: true, prepaymentBalance: true } },
      user: { select: { id: true, displayName: true, email: true } },
      claimedBy: { select: { id: true, displayName: true, email: true } },
      reminders: {
        orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
        include: { createdBy: { select: { id: true, displayName: true } } },
      },
    },
  });
  const visaStayDaysById = await svc.loadBundleVisaStayDays(finalOrder.items);

  return {
    // 对外脱敏：换酒店（AGENT/CUSTOMER 侧也有入口）的返回按操作者角色脱敏。
    order: serializeOrder(finalOrder, { visaStayDaysById, ...orderSerializeRoleCtx(actor.role) }),
    audit: {
      orderNumber: scratch.orderNumber,
      orderItemId: item.id,
      before: {
        hotelRoomTypeId: item.hotelRoomTypeId,
        // 随机单落位：before 没有真实酒店 → 写档次名（「三星随机」），
        // 审计摘要自然渲染成「换酒店 三星随机 → XX酒店·XX房型」
        hotelName: oldRoomType
          ? oldRoomType.hotel.name
          : randomStarTierLabel(item.randomStarTier ?? 0),
        roomTypeName: oldRoomType ? oldRoomType.name : null,
        unitCostCny: beforeUnitCostCny,
        totalCostCny: beforeTotalCostCny,
      },
      after: {
        hotelRoomTypeId: newRoomType.id,
        hotelName: newRoomType.hotel.name,
        roomTypeName: newRoomType.name,
        unitCostCny: afterUnitCostCny,
        totalCostCny: afterTotalCostCny,
      },
      feeCny,
      untrackedNights: scratch.untrackedNights,
      starMismatchOverride,
    },
  };
}

/**
 * 按房组拆分酒店行：把分房表（Order.roomAssignment）里的一个房组，从某条 HOTEL 行
 * 拆成一条独立的 HOTEL 行 —— 「按房组换酒店」的前置步骤：拆完对新行用现成的
 * 「换酒店」按钮（swapItemHotel）即可，只挪这一组人，不动同行其他房组。
 *
 * 钱的哲学（与换酒店「价格冻结」同一套）：**拆行只拆库存归属，不拆应收** ——
 * 新行 amount = 0，源行 amount 一个字不动 → order.subtotal/total 拆前后恒等；
 * 换酒店产生的差价照旧走换酒店端点的 feeCny（adjustmentCny 机制）。
 * 成本侧走真账：totalCostCny 按拆出间数比例从源行挪到新行（Σ 成本守恒），
 * unitCostCny 快照原样复制。
 *
 * 库存对称铁律：源行 roomsBilled -= 拆出数、新行 roomsBilled = 拆出数，Σ 恒等 ——
 * 房控占用由 (hotelRoomTypeId|randomStarTier, hotelCheckIn/Out, roomsBilled) 派生，
 * 本操作绝不隐式增减占用。事务尾对 Σ roomsBilled / Σ totalCostCny / order.total
 * 各做一次守恒断言，不平整体回滚。
 *
 * 房组归属：目标房组的 orderItemId 写成新行 id；本单其余**无归属**的房组顺手回填为
 * 源行 id —— 本单从此每组有归属，房控的归属过滤（expandAssignedPhysicalByDate）即刻生效。
 *
 * 守卫：仅 ADMIN/STAFF；订单占座态且未软删；itemId 必须是本单 kind=HOTEL 行
 * （BUNDLE 行 400 —— 套餐行的钱覆盖整包、无法按间拆成本，请先经「补录房费」加独立
 * 酒店行再拆）；房组必须存在且未归属到其它行；拆出数（roomFraction，缺省 1）与
 * 源行剩余数都必须是 0.5 的整数倍且 > 0（等于源行全额 → 无需拆分，直接换酒店）。
 */
export async function splitHotelItemByRoomGroup(
  svc: OrderService,
  orderId: string,
  itemId: string,
  input: SplitRoomGroupBody,
  actor: { userId: string; role: UserRole },
): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      fromItemId: string;
      newItemId: string;
      roomGroupId: string;
      before: { fromRoomsBilled: number; fromTotalCostCny: number | null };
      after: {
        fromRoomsBilled: number;
        newRoomsBilled: number;
        fromTotalCostCny: number | null;
        newTotalCostCny: number | null;
      };
    };
  }> {
  if (!actorCan(actor, 'orders.hotel.write')) {
    throw new ForbiddenError('仅运营/管理员可拆分房组');
  }

  const scratch = await prisma.$transaction(async (tx) => {
    // Order 行锁：与换酒店/补房差同款 —— 拆行要读-改-写 roomsBilled/roomAssignment，
    // 与并发的分房保存 / 换酒店 / 状态流转严格串行。
    const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
    `;
    if (lockRows.length === 0) throw new NotFoundError('订单不存在');

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        deletedAt: true,
        roomAssignment: true,
        total: true,
      },
    });
    if (!order) throw new NotFoundError('订单不存在');
    if (order.deletedAt) {
      throw new BadRequestError('订单在回收站（已软删），不可拆分房组；如需操作请先恢复');
    }
    if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
      throw new BadRequestError(
        `订单当前状态（${zhStatus(order.status)}）不可拆分房组：仅占座中的有效订单可操作`,
      );
    }

    const item = await tx.orderItem.findUnique({
      where: { id: itemId },
      select: {
        id: true,
        orderId: true,
        kind: true,
        description: true,
        quantity: true,
        unitPrice: true,
        unitCostCny: true,
        totalCostCny: true,
        hotelRoomTypeId: true,
        randomStarTier: true,
        hotelCheckIn: true,
        hotelCheckOut: true,
        roomsBilled: true,
      },
    });
    if (!item || item.orderId !== orderId) {
      throw new NotFoundError('订单项不存在或不属于该订单');
    }
    // 套餐行同样可拆房组（0902 放开）：套餐单没有独立 HOTEL 行，住宿盖章就在套餐行上，
    // 「拆行不拆应收」的金额口径对它一字不差地成立 —— 新行 0 元、源行 amount 不动，
    // 只把 roomsBilled 与成本按间数挪过去。新行落 kind=HOTEL（不是第二条 BUNDLE 行）：
    // 多一条套餐行会让改档（resolveChangeableBundleRow）与拆单的套餐行数闸一起失灵。
    if (item.kind !== OrderItemKind.HOTEL && item.kind !== OrderItemKind.BUNDLE) {
      throw new BadRequestError('该行不是住宿行，无法拆分房组');
    }

    // ── 分房表 & 目标房组（防御式解析，形状不符按缺失处理）──
    const raw = order.roomAssignment;
    const rawGroups =
      raw != null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { roomGroups?: unknown }).roomGroups
        : null;
    if (!Array.isArray(rawGroups) || rawGroups.length === 0) {
      throw new BadRequestError('本单尚无分房表，请先在分房里保存房组，再按房组拆分');
    }
    const target = rawGroups.find(
      (g) => g != null && typeof g === 'object' && (g as { id?: unknown }).id === input.roomGroupId,
    ) as Record<string, unknown> | undefined;
    if (!target) {
      throw new BadRequestError('分房表中不存在该房组，请刷新分房后重试');
    }
    const targetAttribution = target.orderItemId;
    if (
      typeof targetAttribution === 'string' &&
      targetAttribution.length > 0 &&
      targetAttribution !== itemId
    ) {
      throw new BadRequestError('该房组已归属其它订单行，不能从本行拆出');
    }

    // ── 数量守卫（0.5 网格；Σ roomsBilled 守恒的前提）──
    const movedRaw = target.roomFraction == null ? 1 : Number(target.roomFraction);
    if (!Number.isFinite(movedRaw) || movedRaw <= 0) {
      throw new BadRequestError('房组间数（roomFraction）无效，请先修正分房表');
    }
    const movedHalf = Math.round(movedRaw * 2);
    if (movedHalf <= 0 || Math.abs(movedRaw * 2 - movedHalf) > 1e-9) {
      throw new BadRequestError('房组间数必须是 0.5 的整数倍');
    }
    const srcRooms = item.roomsBilled != null ? Number(item.roomsBilled) : null;
    if (srcRooms == null || srcRooms <= 0) {
      throw new BadRequestError('源行未记录计费房数（roomsBilled），请先保存分房表再拆分');
    }
    const srcHalf = Math.round(srcRooms * 2);
    if (Math.abs(srcRooms * 2 - srcHalf) > 1e-9) {
      throw new BadRequestError('源行计费房数不是 0.5 的整数倍，请先核对分房表');
    }
    if (movedHalf === srcHalf) {
      throw new BadRequestError('该房组已占满源行全部房数，无需拆分 —— 直接对源行换酒店即可');
    }
    if (movedHalf > srcHalf) {
      throw new BadRequestError('该房组间数超过源行计费房数，无法拆分，请先核对分房表');
    }
    const moved = movedHalf / 2;
    const remaining = (srcHalf - movedHalf) / 2; // > 0（movedHalf < srcHalf）

    // ── 成本按间数比例挪（Σ 守恒）；钱（amount）全留源行 ──
    const srcTotalCost = item.totalCostCny != null ? Number(item.totalCostCny.toString()) : null;
    const movedCost = srcTotalCost == null ? null : round2((srcTotalCost * movedHalf) / srcHalf);
    const keptCost = srcTotalCost == null || movedCost == null ? null : round2(srcTotalCost - movedCost);

    // 套餐行拆出来的住宿行：单价必须一并归 0（钱全留在套餐行上）。
    // 照抄套餐行的 unitPrice（整包一口价）会得到一条「单价 ¥12800 / 金额 ¥0」的行 ——
    // 运营看不懂，任何按 unitPrice × quantity 复算金额的地方都会把它算成一笔没入账的钱。
    // 描述加后缀点明它是从哪儿拆出来的（新行 kind=HOTEL，不带套餐名会以为是另买的酒店）。
    const isFromBundle = item.kind === OrderItemKind.BUNDLE;
    const created = await tx.orderItem.create({
      data: {
        orderId,
        kind: OrderItemKind.HOTEL,
        description: isFromBundle ? `${item.description}（拆出住宿）` : item.description,
        quantity: item.quantity,
        unitPrice: isFromBundle ? new Prisma.Decimal(0) : item.unitPrice,
        // 拆行只拆库存归属不拆应收：新行 0 元，源行 amount 不动 → subtotal/total 恒等
        amount: new Prisma.Decimal(0),
        unitCostCny: item.unitCostCny,
        totalCostCny: movedCost == null ? null : new Prisma.Decimal(movedCost),
        hotelRoomTypeId: item.hotelRoomTypeId,
        randomStarTier: item.randomStarTier,
        hotelCheckIn: item.hotelCheckIn,
        hotelCheckOut: item.hotelCheckOut,
        roomsBilled: new Prisma.Decimal(moved),
        idempotencyKey: null,
        metadata: {
          splitRoomGroup: {
            fromItemId: item.id,
            roomGroupId: input.roomGroupId,
            at: new Date().toISOString(),
          },
          ...(input.note ? { note: input.note } : {}),
        } as Prisma.InputJsonValue,
      },
    });
    await tx.orderItem.update({
      where: { id: item.id },
      data: {
        roomsBilled: new Prisma.Decimal(remaining),
        totalCostCny: keptCost == null ? null : new Prisma.Decimal(keptCost),
      },
    });

    // ── 房组归属：目标组指到新行；其余无归属组回填为源行（本单从此每组有归属）──
    const newGroups = rawGroups.map((g) => {
      if (g == null || typeof g !== 'object') return g;
      const rec = g as Record<string, unknown>;
      if (rec.id === input.roomGroupId) return { ...rec, orderItemId: created.id };
      const existing = rec.orderItemId;
      if (typeof existing === 'string' && existing.length > 0) return rec;
      return { ...rec, orderItemId: item.id };
    });
    await tx.order.update({
      where: { id: orderId },
      data: {
        roomAssignment: {
          ...(raw as Record<string, unknown>),
          roomGroups: newGroups,
        } as Prisma.InputJsonValue,
      },
    });

    // ── 守恒断言（不平整体回滚）：Σ roomsBilled、Σ totalCostCny、order.total 拆前后一致 ──
    const [afterSrc, afterNew, afterOrder] = await Promise.all([
      tx.orderItem.findUniqueOrThrow({
        where: { id: item.id },
        select: { roomsBilled: true, totalCostCny: true },
      }),
      tx.orderItem.findUniqueOrThrow({
        where: { id: created.id },
        select: { roomsBilled: true, totalCostCny: true },
      }),
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { total: true } }),
    ]);
    const halfOf = (v: Prisma.Decimal | null): number =>
      v == null ? 0 : Math.round(Number(v.toString()) * 2);
    const centsOf = (v: Prisma.Decimal | null): number =>
      v == null ? 0 : Math.round(Number(v.toString()) * 100);
    if (halfOf(afterSrc.roomsBilled) + halfOf(afterNew.roomsBilled) !== srcHalf) {
      throw new Error('拆分守恒校验未通过（Σ roomsBilled 与拆前不符），已回滚');
    }
    const costBeforeCents = srcTotalCost == null ? 0 : Math.round(srcTotalCost * 100);
    if (centsOf(afterSrc.totalCostCny) + centsOf(afterNew.totalCostCny) !== costBeforeCents) {
      throw new Error('拆分守恒校验未通过（Σ totalCostCny 与拆前不符），已回滚');
    }
    if (afterOrder.total.toString() !== order.total.toString()) {
      throw new Error('拆分守恒校验未通过（order.total 被改动），已回滚');
    }

    return {
      orderNumber: order.orderNumber,
      fromItemId: item.id,
      newItemId: created.id,
      roomGroupId: input.roomGroupId,
      before: { fromRoomsBilled: srcRooms, fromTotalCostCny: srcTotalCost },
      after: {
        fromRoomsBilled: remaining,
        newRoomsBilled: moved,
        fromTotalCostCny: keptCost,
        newTotalCostCny: movedCost,
      },
    };
  });

  const finalOrder = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: ORDER_FULL_INCLUDE,
  });
  return {
    order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
    audit: scratch,
  };
}

/**
 * 酒店改期：把某条 HOTEL 行的入住/退房日期整体挪到新区间。
 *
 * 与「换酒店」是一对姊妹能力：换酒店改的是「住哪」，改期改的是「住哪几晚」。房控占房本就
 * 由订单行的 (hotelRoomTypeId, hotelCheckIn, hotelCheckOut, roomsBilled) 派生 —— 改写日期
 * 这一步本身就等于「释放旧区间 + 占用新区间」，两件事在同一条 UPDATE 里原子完成，中间不存在
 * 「旧的放了、新的还没占」的窗口；新区间余量不足则整事务回滚，旧区间的占房分毫未动。
 *
 * body：{ newCheckIn, newCheckOut, feeCny?, feeLabel?, note? }
 *   - itemId 必须属于本订单且 kind=HOTEL（BUNDLE 行的住宿日期由套餐行程决定，不从这里单独挪）。
 *   - newCheckOut 必须晚于 newCheckIn；跨度超出住宿上限（见 buildStayNightDates）→ 拒绝。
 *   - 新旧区间完全相同 → 400（无意义改期）。
 *
 * 定价哲学（甲案，与换酒店的"价格默认冻结"同一套）：
 *   **行价与数量一个字不动** —— unitPrice / amount / quantity(晚数计价乘数) / roomsBilled 全部冻结，
 *   绝不因晚数变化自动加钱或退钱。晚数变了要收/退的差额，由 feeCny 走售后费行
 *   （adjustmentCny + adjustments 流水，label 缺省「酒店改期差价」），与改期费/换人费/换酒店差价
 *   同一机制，计入订单应收。这样「系统自动算的钱」和「人工确认的钱」始终泾渭分明。
 *
 * 房控库存（新区间必须装得下，否则整体拒绝）：
 *   - 具体酒店行（有 hotelRoomTypeId）：先锁目标酒店该区间的包房周期行（并发互斥的唯一正解），
 *     再走物理房间口径前瞻闸。`excludeOrderId` 排除本单自身占房 —— 对同酒店改期而言，这正是
 *     「先释放旧区间」的效果（本单在该酒店的其它 HOTEL 行也会被一并排除，属已知口径；
 *     换酒店已升级为行级排除 excludeOrderItemIds，改期后续可跟进）。
 *   - 未落位随机档行（randomStarTier 非空、无房型）：走随机档聚合余量闸（Σ同星级真酒店余量 −
 *     未落位占用），口径与下单/落位一致。
 *
 * description 里的日期段与晚数段按新区间就地改写（其余部分原样保留，见 rewriteHotelStayDescription）。
 */
export async function rescheduleItemHotel(
  svc: OrderService,
  orderId: string,
  itemId: string,
  input: RescheduleItemHotelBody,
  actor: { userId: string; role: UserRole },
): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      orderItemId: string;
      before: { checkIn: string; checkOut: string; nights: number };
      after: { checkIn: string; checkOut: string; nights: number };
      feeCny: number;
      untrackedNights: string[];
    };
  }> {
  // 权限口径与机票改期/换酒店完全一致（路由层也断言一次，双闸）。
  if (!actorCan(actor, 'orders.hotel.write')) {
    throw new ForbiddenError('仅运营/管理员可改酒店入住日期');
  }
  const feeCny = Math.trunc(input.feeCny ?? 0);

  // ── 新区间解析与校验（date-only：与建单/房控同款 UTC 零点口径）──
  // 逐字回读 ISO 日期：`2026-02-31` 这类不存在的日期会被 Date 悄悄顺延到 3 月，回读能揪出来。
  const newCheckIn = new Date(`${input.newCheckIn}T00:00:00.000Z`);
  const newCheckOut = new Date(`${input.newCheckOut}T00:00:00.000Z`);
  if (
    Number.isNaN(newCheckIn.getTime()) ||
    newCheckIn.toISOString().slice(0, 10) !== input.newCheckIn
  ) {
    throw new BadRequestError('入住日期无效');
  }
  if (
    Number.isNaN(newCheckOut.getTime()) ||
    newCheckOut.toISOString().slice(0, 10) !== input.newCheckOut
  ) {
    throw new BadRequestError('退房日期无效');
  }
  if (newCheckOut.getTime() <= newCheckIn.getTime()) {
    throw new BadRequestError('退房日期必须晚于入住日期');
  }
  const nightDates = buildStayNightDates(newCheckIn, newCheckOut);
  if (nightDates.length === 0) {
    throw new BadRequestError(`住宿区间过长（最多 ${MAX_STAY_NIGHTS} 晚），请核对入住/退房日期`);
  }
  const newNights = nightDates.length;

  const item = await prisma.orderItem.findUnique({
    where: { id: itemId },
    select: {
      id: true,
      orderId: true,
      kind: true,
      description: true,
      hotelRoomTypeId: true,
      randomStarTier: true,
      hotelCheckIn: true,
      hotelCheckOut: true,
      roomsBilled: true,
    },
  });
  if (!item || item.orderId !== orderId) {
    throw new NotFoundError('订单项不存在或不属于该订单');
  }
  // BUNDLE 行的住宿日期跟着套餐行程走（由去/回程日期盖章），单独挪它会与航段脱钩 —— 一律拒绝。
  if (item.kind !== OrderItemKind.HOTEL) {
    throw new BadRequestError('只能对酒店行（HOTEL）改期');
  }
  if (!item.hotelCheckIn || !item.hotelCheckOut) {
    throw new BadRequestError('该酒店行没有入住/退房日期，无法改期');
  }
  if (!item.hotelRoomTypeId && item.randomStarTier == null) {
    throw new BadRequestError('该行不含酒店，无法改期');
  }
  const beforeCheckIn = formatDateOnly(item.hotelCheckIn);
  const beforeCheckOut = formatDateOnly(item.hotelCheckOut);
  if (beforeCheckIn === input.newCheckIn && beforeCheckOut === input.newCheckOut) {
    throw new BadRequestError('新入住/退房日期与当前相同，无需改期');
  }
  const beforeNights = buildStayNightDates(item.hotelCheckIn, item.hotelCheckOut).length;

  const roomsBilled = item.roomsBilled != null ? Number(item.roomsBilled.toString()) : 1;
  // 具体酒店行要按酒店维度锁包房周期 + 判物理余量；随机档行没有落到酒店，走聚合闸。
  const roomType = item.hotelRoomTypeId
    ? await prisma.hotelRoomType.findUnique({
        where: { id: item.hotelRoomTypeId },
        select: { id: true, hotelId: true },
      })
    : null;
  if (item.hotelRoomTypeId && !roomType) {
    throw new NotFoundError('酒店房型数据异常，无法改期');
  }

  const newDescription = rewriteHotelStayDescription(item.description, {
    checkIn: input.newCheckIn,
    checkOut: input.newCheckOut,
    nights: newNights,
  });

  const scratch = await prisma.$transaction(async (tx) => {
    // Order 行锁：与换酒店/机票改期/换人/到账入账同一把锁 —— adjustmentCny 是读-改-写，
    // 无锁并发会互相覆盖（少收一笔）。同时也让状态流转与本次改期严格串行。
    const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
    `;
    if (lockRows.length === 0) throw new NotFoundError('订单不存在');

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        deletedAt: true,
        adjustmentCny: true,
        adjustments: true,
        total: true,
      },
    });
    if (!order) throw new NotFoundError('订单不存在');

    // ── 有效订单双闸（与换酒店同款）──
    // 改期会把占房挪到新区间、并可能通过 feeCny 改客户应付。死单/回收站单上改期 →
    // 死单凭空占住真实房量，且长出一笔并不存在的「欠款」。
    if (order.deletedAt) {
      throw new BadRequestError('订单在回收站（已软删），不可改期；如需操作请先恢复');
    }
    if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
      throw new BadRequestError(
        `订单当前状态（${zhStatus(order.status)}）不可改期：仅占座中的有效订单可改期（已取消/已退款/超时订单请勿改期）`,
      );
    }

    // ── 新区间余量闸（事务内互斥版）──
    let untrackedNights: string[] = [];
    if (roomType) {
      // 先锁目标区间的包房周期行，判定与下方写日期落库之间不留窗口，
      // 否则两笔并发改期会各自读到「还剩 1 间」的旧快照双双通过。
      await lockHotelBlockPeriodsWithinTx(tx, roomType.hotelId, nightDates);
      const orderPassengers = await tx.passenger.findMany({
        where: { orderId },
        select: { gender: true },
      });
      const fit = await checkHotelPhysicalFit(
        roomType.hotelId,
        nightDates,
        toProspectiveOccupancy(
          roomsBilled,
          orderPassengers.map((p) => ({ gender: p.gender ?? undefined })),
        ),
        // 排除本单自身占房 = 「先释放旧区间」；随后把本行房量按新区间加回去（prospective）。
        { excludeOrderId: orderId },
        tx,
      );
      if (fit.hasBlock) {
        untrackedNights = nightDates.filter((_, i) => fit.block[i] === 0);
        if (fit.violations.length > 0) {
          const detail = fit.violations
            .map(
              (v) =>
                `${formatMonthDay(new Date(`${v.date}T00:00:00.000Z`))}实际房间不足（包房 ${v.block} 间，改到新日期后需 ${v.physicalUsed} 间）`,
            )
            .join('；');
          throw new BadRequestError(detail);
        }
      } else {
        // 整段没有任何包房周期 → 未纳入管控（房控哲学：未配包房 ≠ 售罄）
        untrackedNights = [...nightDates];
      }
    } else {
      // 未落位随机档行：按同星级聚合余量判定（口径同下单/落位）。
      // 用带锁版：此前虽已在事务内、传了 tx，但没有 FOR UPDATE —— 只读判定挡不住并发，
      // 两笔改期同时挤进同一档次的最后一间会双双通过。带锁版先锁该档次全部真酒店在该
      // 区间的包房周期行，与下方写新日期落库同事务，判定与落库之间不留窗口。
      // 单独随机行没有酒店也就没有城市 → 存量默认城市（见 hotel-city.ts）。
      await assertRandomTierFitWithinTx(
        tx,
        { tier: item.randomStarTier!, cityCode: RANDOM_TIER_LEGACY_CITY_CODE },
        nightDates,
        roomsBilled,
        {
          excludeOrderId: orderId,
          maxOversellRooms: RANDOM_TIER_INTERNAL_NO_CAP,
        },
      );
    }

    // ── 减价不能把应付冲成负数（与换酒店同一道闸）──
    // 减价是合法操作，但没有下限就能把 effectivePayable（total + adjustmentCny）冲成负数，
    // 账面上凭空「欠客户钱」，而这笔欠款并没有对应的退款流水。
    if (feeCny < 0) {
      const currentPayable = round2(Number(order.total.toString()) + order.adjustmentCny);
      if (round2(currentPayable + feeCny) < 0) {
        throw new BadRequestError('减价金额不能超过当前应付（最多减到应付为 0）');
      }
    }

    // ── 1. 改写住宿区间 + description（金额/数量/间数/房型一律冻结）──
    // 这一条 UPDATE 同时完成「释放旧区间」与「占用新区间」：房控占房完全由这几个字段派生。
    await tx.orderItem.update({
      where: { id: item.id },
      data: {
        hotelCheckIn: newCheckIn,
        hotelCheckOut: newCheckOut,
        description: newDescription,
      },
    });

    // ── 2. 可选酒店改期差价（与改期费/换酒店差价同一 adjustmentCny 机制）──
    if (feeCny !== 0) {
      const log = appendAdjustment(order.adjustments, {
        type: 'HOTEL_RESCHEDULE_FEE',
        label: input.feeLabel || '酒店改期差价',
        amountCny: feeCny,
        at: new Date().toISOString(),
        by: actor.userId,
        note: input.note,
      });
      await tx.order.update({
        where: { id: orderId },
        data: { adjustmentCny: order.adjustmentCny + feeCny, adjustments: log },
      });
    }

    // 按人份额落库（R1）：酒店改期差价进了 adjustmentCny，每人份额随之重算。
    await persistPassengerShares(tx, orderId);
    return { orderNumber: order.orderNumber, untrackedNights };
  });

  const finalOrder = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: ORDER_FULL_INCLUDE,
  });

  return {
    // 对外脱敏：按操作者角色脱敏（ADMIN/STAFF 全量，其余剥离内部字段 + 逐项拆价）。
    order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
    audit: {
      orderNumber: scratch.orderNumber,
      orderItemId: item.id,
      before: { checkIn: beforeCheckIn, checkOut: beforeCheckOut, nights: beforeNights },
      after: { checkIn: input.newCheckIn, checkOut: input.newCheckOut, nights: newNights },
      feeCny,
      untrackedNights: scratch.untrackedNights,
    },
  };
}

// ════════════════════════════════════════════════════════════════════
// T5：更改订单归属代理（硬守卫 + 留审计）
// 全程 ADMIN/STAFF（路由层 + 服务层双断言）。
//
// 财务口径（不回溯）：改归属绝不回滚任何已发生的资金账 —— 已收的款、已用原代理预存余额抵扣、
// 已计提的佣金流水，一律按「事发时」的归属保留，不因本次改归属而重算或退回；本次变更只影响
// 变更之后新产生的佣金/结算按新归属计。回收站单、已退款单、曾用原代理预存余额抵扣的订单拒绝，
// 目标代理必须存在且在用；warning 字段保留为空以维持 API 形状。
// ════════════════════════════════════════════════════════════════════
export async function changeOrderAgent(
  svc: OrderService,
  orderId: string,
  input: { agentId: string | null; reason?: string },
  actor: { userId: string; role: UserRole },
): Promise<{
    order: ReturnType<typeof serializeOrder>;
    warning: string | null;
    audit: {
      orderNumber: string;
      before: { agentId: string | null; agentName: string | null };
      after: { agentId: string | null; agentName: string | null };
      reason?: string;
      usedAgentBalance: boolean;
    };
  }> {
  if (!actorCan(actor, 'orders.agent.write')) {
    throw new ForbiddenError('仅运营/管理员可更改订单归属代理');
  }
  const newAgentId = input.agentId ?? null;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, agentId: true, status: true, deletedAt: true },
  });
  if (!order) throw new NotFoundError('订单不存在');

  // 状态/软删守卫（A16）：回收站单与已退款单不该再改归属——
  //   · 回收站单（deletedAt≠null）：已软删隐身，改归属只会在恢复后制造一个归属被人动过的幽灵单。
  //   · 已退款单（REFUNDED，终态）：钱已结清，改代理无业务意义，只会污染报表归属。
  // 此前 select 连 status/deletedAt 都不取，这两类单都能被静默改归属。
  if (order.deletedAt) {
    throw new BadRequestError('回收站订单不能更改归属代理，请先恢复订单');
  }
  if (order.status === OrderStatus.REFUNDED) {
    throw new BadRequestError('已退款订单不能更改归属代理');
  }

  const oldAgentId = order.agentId;
  if (oldAgentId === newAgentId) {
    throw new BadRequestError('归属代理未变化');
  }

  // 目标代理校验（转直客 newAgentId=null 时跳过）：必须存在且在用，与建单归属同口径。
  let newAgentName: string | null = null;
  if (newAgentId) {
    const agent = await prisma.agent.findUnique({
      where: { id: newAgentId },
      select: { id: true, isActive: true, companyName: true, contactName: true },
    });
    if (!agent) throw new NotFoundError(`指定的代理不存在：${newAgentId}`);
    if (!agent.isActive) throw new BadRequestError('指定的代理已停用，无法归属订单');
    newAgentName = agent.companyName ?? agent.contactName;
  }

  // 旧代理名（审计/展示用；代理已被删/查不到时安全落 null）。
  let oldAgentName: string | null = null;
  if (oldAgentId) {
    const old = await prisma.agent.findUnique({
      where: { id: oldAgentId },
      select: { companyName: true, contactName: true },
    });
    oldAgentName = old ? old.companyName ?? old.contactName : null;
  }

  // 资金纠缠阻断（A16b，2026-07-17 拍板：有余额纠缠时阻断、强制先结清）：
  // 该订单若曾用（原代理）预存余额抵扣（applyAgentBalanceToOrder 挂 PrepaymentTransaction(OFFSET)），
  // 改归属后「多付转余额」会按新 agentId 入账 —— 原代理 A 的钱会变成新代理 B 的余额。
  // 旧口径只给警告不阻断；现改为硬阻断：先由财务把原代理的抵扣结清/冲回，再改归属。
  const balanceOffset = await prisma.prepaymentTransaction.findFirst({
    where: { orderId, type: PrepaymentTxType.OFFSET },
    select: { id: true },
  });
  if (balanceOffset != null) {
    throw new BadRequestError(
      '该订单曾用原代理预存余额抵扣，直接改归属会把原代理的钱记到新归属名下。' +
        '请先由财务结清/冲回该笔余额抵扣，再更改归属代理。',
    );
  }
  const usedAgentBalance = false; // 走到这里必然无 OFFSET（保留字段以稳定 API 形状）

  // ── 价格纠缠拆解（改归属最小安全动作）────────────────────────────────────
  // 旧口径只改 agentId：原代理 A 的立减 DISCOUNT 行、按 A 谈定的结算价差额行原样留给 B，
  // 而佣金之后按 B 的费率计提 —— 一单同时挂着两家代理的价格口径，谁也说不清这单该收多少。
  // 本次处置分两半：
  //   · 立减行（规则命中的 DISCOUNT，metadata.ruleId 有值）= 按 A 的规则库算出来的，
  //     对 B 无效 → **撤销并重算 subtotal/total**，让应收回到未打折的口径，由运营按 B 重新核价。
  //   · 结算价差额行（metadata.settlementPrice）= 人工与 A 谈定的一口价，撤销它等于替运营
  //     做价格决定 → **不自动动**，只在 warning 里点名，让运营自己决定改不改。
  const scratch = await prisma.$transaction(async (tx) => {
    // 与改结算价/补房差同一把锁：重算 subtotal/total 要「读 items → 聚合 → 写回 Order」，
    // 无锁时并发改价会各自从陈旧快照重算、后写覆盖前写。
    const locked = await tx.$queryRaw<
      Array<{
        id: string;
        subtotal: Prisma.Decimal;
        total: Prisma.Decimal;
        paidAmount: Prisma.Decimal;
        settlementLocked: boolean;
      }>
    >`SELECT id, subtotal, total, "paidAmount", "settlementLocked" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const lockedOrder = locked[0];
    // 上面已按 id 查到过订单；锁的时候没了 = 并发删单，别拿半份数据继续算钱。
    if (!lockedOrder) throw new NotFoundError('订单不存在');

    // 锁之后才读行：锁之前那份快照可能已被并发改价写脏。
    const items = await tx.orderItem.findMany({
      where: { orderId },
      select: { id: true, kind: true, description: true, amount: true, metadata: true },
    });

    const readMetadata = (raw: unknown): Record<string, unknown> =>
      raw != null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};

    // 待撤销的立减行：规则命中（有 ruleId 快照）且尚未撤销的 DISCOUNT 行。
    // 手工 DISCOUNT 调价行没有 ruleId，不在此列 —— 那是运营自己填的，不随代理走。
    const revocableRows = items.filter((row) => {
      if (row.kind !== OrderItemKind.DISCOUNT) return false;
      const metadata = readMetadata(row.metadata);
      return (
        metadata.settlementDiscount === true &&
        metadata.settlementDiscountRevoked !== true &&
        typeof metadata.ruleId === 'string'
      );
    });

    // 结算价差额行（不自动动，只点名）：金额为 0 的不提，没什么可说的。
    const settlementRows = items.filter((row) => {
      const metadata = readMetadata(row.metadata);
      return metadata.settlementPrice === true && Number(row.amount) !== 0;
    });

    // 资金处置闸：撤立减会改 order.total（也是取消手续费/应退额的基数），取消族/超时/
    // 退款审批中的单一律不动金额 —— 否则能在批准退款前悄悄抬高应退额。
    // 但**改归属本身仍放行**（报表归属订正是这类单的正当需求），只是把没撤的立减在 warning 里点名。
    const canAdjustMoney = !FUNDS_DISPOSE_BLOCKED_STATUSES.includes(order.status);

    // 结算价锁：本次要改的正是订单金额，锁的语义（核对后禁止改价）在这里同样成立。
    // 没有立减行要撤 → 不改金额 → 与旧口径一样放行，不给日常改归属平添拒绝。
    if (revocableRows.length > 0 && canAdjustMoney && lockedOrder.settlementLocked) {
      throw new ConflictError(
        '该订单结算价已锁定，而本次改归属需要撤销原代理的立减行（会改动应收）。请先解锁结算价再改归属。',
      );
    }

    const revoked: Array<{ description: string; amountCny: number }> = [];
    for (const row of canAdjustMoney ? revocableRows : []) {
      const metadata = readMetadata(row.metadata);
      const amountCny = Math.abs(Number(row.amount) || 0);
      await tx.orderItem.update({
        where: { id: row.id },
        data: {
          // 撤销 = 金额归零 + 打撤销标记，**不删行**：这条立减发生过，留着可查
          // （与改期撤立减同一套 settlementDiscountRevoked 标记，行级幂等）。
          unitPrice: new Prisma.Decimal(0),
          amount: new Prisma.Decimal(0),
          description: row.description.startsWith('（已撤销）')
            ? row.description
            : `（已撤销）${row.description}`,
          metadata: {
            ...metadata,
            settlementDiscountRevoked: true,
            revokedReason: 'AGENT_CHANGED',
            revokedAt: new Date().toISOString(),
            revokedBy: actor.userId,
            revokedAmountCny: amountCny,
          } as Prisma.InputJsonValue,
        },
      });
      revoked.push({ description: row.description, amountCny });
    }

    // 从库里重新聚合最新 items 算 subtotal/total（上面的 update 已落在同一事务内）。
    // 无立减行可撤时跳过：金额没变，不必平白写一次 Order。
    let newTotalCny: number | null = null;
    if (revoked.length > 0) {
      const sumAgg = await tx.orderItem.aggregate({ where: { orderId }, _sum: { amount: true } });
      const newSubtotal = round2(
        Number((sumAgg._sum.amount ?? new Prisma.Decimal(0)).toString()),
      );
      newTotalCny = newSubtotal; // 当前无 taxes/discount，total = subtotal
      await tx.order.update({
        where: { id: orderId },
        data: {
          agentId: newAgentId,
          subtotal: new Prisma.Decimal(newSubtotal),
          total: new Prisma.Decimal(newTotalCny),
        },
      });
    } else {
      await tx.order.update({ where: { id: orderId }, data: { agentId: newAgentId } });
    }

    // 已计提佣金：按**事发时**的归属和费率提的，改归属不回溯重算（见本方法头部财务口径）。
    const accruedCommissions = await tx.commissionRecord.findMany({
      where: { orderId, status: { in: [CommissionStatus.ACCRUED, CommissionStatus.SETTLED] } },
      select: { amount: true },
    });
    const accruedCommissionCny = round2(
      accruedCommissions.reduce((s, c) => s + Number(c.amount.toString()), 0),
    );

    // 按人份额落库（R1）：本事务改了应收 / 行金额，提交前把每人份额重算落库（写点见 service/passenger-shares.ts）。
    await persistPassengerShares(tx, orderId);
    return {
      revoked,
      revokedTotalCny: round2(revoked.reduce((s, r) => s + r.amountCny, 0)),
      // 状态不允许动金额时没撤成的立减（只报，不动）。
      skippedDiscountCount: canAdjustMoney ? 0 : revocableRows.length,
      skippedDiscountTotalCny: canAdjustMoney
        ? 0
        : round2(
            revocableRows.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0),
          ),
      settlementRowCount: settlementRows.length,
      settlementRowTotalCny: round2(
        settlementRows.reduce((s, r) => s + Number(r.amount), 0),
      ),
      beforeTotalCny: round2(Number(lockedOrder.total.toString())),
      newTotalCny,
      paidAmountCny: round2(Number(lockedOrder.paidAmount.toString())),
      accruedCommissionCny: accruedCommissions.length > 0 ? accruedCommissionCny : null,
    };
  });

  // 撤销立减留一条 WARNING 审计：应收被系统改动过，财务/运营要能翻得出来。
  if (scratch.revoked.length > 0) {
    await writeAudit({
      actor: { userId: actor.userId, role: actor.role },
      action: 'AGENT_CHANGED_DISCOUNT_REVOKED',
      targetType: 'ORDER',
      targetId: orderId,
      targetLabel: order.orderNumber,
      before: { total: scratch.beforeTotalCny, agentId: oldAgentId },
      after: {
        total: scratch.newTotalCny,
        agentId: newAgentId,
        revokedCny: scratch.revokedTotalCny,
        revokedRows: scratch.revoked,
        reason: input.reason ?? null,
      },
      severity: AuditSeverity.WARNING,
    });
  }

  const finalOrder = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: ORDER_FULL_INCLUDE,
  });

  // warning：把「系统替你动了什么 / 还有什么等你决定」一次讲清，别让运营事后才发现金额变了。
  const warningParts: string[] = [];
  if (scratch.revoked.length > 0) {
    warningParts.push(
      `已撤销原代理口径的立减 ${scratch.revoked.length} 条（合计 ¥${scratch.revokedTotalCny}），` +
        `订单应收由 ¥${scratch.beforeTotalCny} 调整为 ¥${scratch.newTotalCny}。请按新代理口径重新核价。`,
    );
  }
  if (scratch.skippedDiscountCount > 0) {
    warningParts.push(
      `该订单当前状态（${zhStatus(order.status)}）不允许改动金额，` +
        `原代理口径的立减 ${scratch.skippedDiscountCount} 条（合计 ¥${scratch.skippedDiscountTotalCny}）未撤销，请人工核对处理。`,
    );
  }
  if (scratch.settlementRowCount > 0) {
    warningParts.push(
      `本单还有 ${scratch.settlementRowCount} 条结算价差额行（合计 ¥${scratch.settlementRowTotalCny}），` +
        '是按原代理谈定的一口价，系统未自动改动 —— 请确认新代理是否沿用该结算价。',
    );
  }
  if (scratch.newTotalCny !== null && scratch.paidAmountCny > scratch.newTotalCny) {
    warningParts.push(
      `该单已收 ¥${scratch.paidAmountCny}，调整后应收 ¥${scratch.newTotalCny}，` +
        `形成多付 ¥${round2(scratch.paidAmountCny - scratch.newTotalCny)}。` +
        '请在订单资金区做多付处置（转代理余额 / 转挂账池 / 退款）。',
    );
  }
  if (scratch.accruedCommissionCny !== null) {
    warningParts.push(
      `本单已计提佣金 ¥${scratch.accruedCommissionCny}（按原归属与当时费率），改归属不回溯重算，请财务确认是否调整。`,
    );
  }
  const warning = warningParts.length > 0 ? warningParts.join(' ') : null;

  return {
    // 显式按角色推导序列化口径（本入口已断言 ADMIN/STAFF → 保留护照大图，与改归属前的返回一致）。
    // serializeOrder 的护照大图缺省是 fail-closed，不显式传 ctx 会静默剥掉后台需要的缩略图。
    order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
    warning,
    audit: {
      orderNumber: order.orderNumber,
      before: { agentId: oldAgentId, agentName: oldAgentName },
      after: { agentId: newAgentId, agentName: newAgentName },
      reason: input.reason,
      usedAgentBalance,
    },
  };
}

// ════════════════════════════════════════════════════════════════════
// 事后补收单房差（ADMIN/STAFF）
// 建单后按「每晚金额 × 晚数」补收单房差：单事务内新增一条 FEE 调整行 + 重算 order.subtotal/total
// + 追加 order.adjustments 审计流水（参考改期费的 appendAdjustment 模式）。
//
// 钱口径：金额随新 FEE 行进入 subtotal/total（应付/尾款自然增加）——不走 adjustmentCny（那是
// 改期费/换人费的机制），避免与本行重复计钱。order.adjustments 只作审计流水（不参与金额合计）。
// 仅含 BUNDLE/HOTEL 行的订单可用（纯机票单无住宿 → 400）。
// ════════════════════════════════════════════════════════════════════
/**
 * 订单详情补录一条结构化 HOTEL/VISA 行。
 * 产品只负责提供当前成本与展示名称；落库后的收入单价和成本快照互不回写。
 */
export async function addGroundItem(
  svc: OrderService,
  orderId: string,
  input: AddGroundItemBody,
  actor: { userId: string; role: UserRole },
): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      itemId: string;
      kind: 'VISA' | 'HOTEL';
      productId: string;
      amountCny: number;
      unitPriceCny: number;
      unitCostCny: number | null;
      totalCostCny: number | null;
      visaTaskCreated: boolean;
    };
  }> {
  if (!actorCan(actor, 'orders.add_ground_item')) {
    throw new ForbiddenError('仅运营/管理员可补录签证或房费');
  }

  const scratch = await prisma.$transaction(async (tx) => {
    // 与补房差/调价相同：锁订单后再读取行，避免并发补录丢失订单总额更新。
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        deletedAt: true,
        visaStatus: true,
        subtotal: true,
        total: true,
        items: { select: { amount: true } },
      },
    });
    if (!order) throw new NotFoundError('订单不存在');
    // 资金闸与其他改 total 通道同源：已退款/超时/草稿/已取消/回收站单一律拒绝，
    // 防止终态订单的历史金额被追加地面项改写。
    assertOrderAcceptsFunds(order);

    let productName: string;
    let costPriceCny: number | null;
    let unitPriceCny: number;
    let quantity: number;
    let rooms: number | undefined;
    let description: string;
    let hotelCheckIn: Date | null = null;
    let hotelCheckOut: Date | null = null;
    // 签证行的「预计出行日期」锚点（可空）：纯签证单派生整单出发日的第三级回退，
    // 与建单路径落的是同一列，按出发日期区间导出才捞得到后补的签证单。
    let visaIntendedDate: Date | null = null;
    let visaTaskCreated = false;

    if (input.kind === 'VISA') {
      const visa = await tx.visa.findUnique({
        where: { id: input.visaId },
        select: {
          id: true,
          visaName: true,
          visaType: true,
          country: true,
          destinationCountry: true,
          costPriceCny: true,
          isActive: true,
        },
      });
      if (!visa) throw new NotFoundError(`签证产品 ${input.visaId} 不存在`);
      if (!visa.isActive) throw new BadRequestError('签证产品已下架');
      productName = visa.visaName ?? visa.visaType ?? visa.country ?? visa.destinationCountry;
      costPriceCny = visa.costPriceCny == null ? null : Number(visa.costPriceCny);
      unitPriceCny = resolveGroundItemUnitPrice({
        requestedUnitPriceCny: input.unitPriceCny,
        costPriceCny,
        label: '签证',
      });
      quantity = input.quantity ?? (await tx.passenger.count({ where: { orderId } }));
      if (quantity < 1) throw new BadRequestError('该订单没有乘客，无法按人数补录签证');
      description = `${productName} × ${quantity}人`;
      // @db.Date 列：按 UTC 零点写入（与建单路径、hotelCheckIn 同款），不折时区。
      if (input.visaIntendedDate) {
        visaIntendedDate = new Date(`${input.visaIntendedDate}T00:00:00.000Z`);
        if (
          Number.isNaN(visaIntendedDate.getTime()) ||
          visaIntendedDate.toISOString().slice(0, 10) !== input.visaIntendedDate
        ) {
          throw new BadRequestError('预计出行日期无效');
        }
      }
    } else {
      const roomType = await tx.hotelRoomType.findUnique({
        where: { id: input.hotelRoomTypeId },
        select: {
          id: true,
          name: true,
          costPriceCny: true,
          hotel: { select: { name: true, isActive: true } },
        },
      });
      if (!roomType) throw new NotFoundError(`酒店房型 ${input.hotelRoomTypeId} 不存在`);
      if (!roomType.hotel.isActive) throw new BadRequestError('酒店已下架');
      productName = `${roomType.hotel.name} ${roomType.name}`;
      costPriceCny = roomType.costPriceCny == null ? null : Number(roomType.costPriceCny);
      unitPriceCny = resolveGroundItemUnitPrice({
        requestedUnitPriceCny: input.unitPriceCny,
        costPriceCny,
        label: '酒店房型',
      });
      quantity = input.nights;
      rooms = input.rooms;
      const roomsLabel = Number.isInteger(rooms) ? String(rooms) : rooms.toFixed(1);
      description = `${productName} × ${quantity}晚 × ${roomsLabel}间`;
      if (input.checkIn) {
        hotelCheckIn = new Date(`${input.checkIn}T00:00:00.000Z`);
        hotelCheckOut = new Date(`${addDaysToYmd(input.checkIn, quantity)}T00:00:00.000Z`);
        if (
          Number.isNaN(hotelCheckIn.getTime()) ||
          Number.isNaN(hotelCheckOut.getTime()) ||
          hotelCheckIn.toISOString().slice(0, 10) !== input.checkIn
        ) {
          throw new BadRequestError('入住日期无效');
        }
      }
    }

    // ── 酒店房量闸（CRITICAL 修复，与建单同一把闸）───────────────────────────
    // 补录房费与建单一样是「往真实酒店新增占房」，此前同样一道闸都没有：售罄后照样补录，
    // 销控板直接变负。本调用已在事务内并持有 Order 行锁，这里再锁目标酒店该区间的包房周期行
    // 后判定，与下方 orderItem.create 落库同一事务，判定与落库之间没有窗口。
    // 无入住日期（未填 checkIn）→ 无从判定占的是哪几晚，与既有「不盖日期就不进房控」口径一致，跳过。
    // 后台补录：房量不足要让运营看得见差多少间，故用默认的带数字文案（不套对外中性话术）。
    if (input.kind === 'HOTEL' && hotelCheckIn && hotelCheckOut) {
      const orderPassengers = await tx.passenger.findMany({
        where: { orderId },
        select: { gender: true },
      });
      await assertHotelStaysFitWithinTx(
        tx,
        [
          {
            hotelRoomTypeId: input.hotelRoomTypeId,
            hotelCheckIn,
            hotelCheckOut,
            roomsBilled: rooms,
          },
        ],
        orderPassengers.map((p) => ({ gender: p.gender ?? undefined })),
        // 不传 excludeOrderId：本单在该酒店**已有**的占房是真实存量，补录是在它之上再加一笔，
        // 排除本单等于把自己已占的房当成空房，会放行超卖。
      );
    }

    const priced = computeGroundItemAmounts({
      kind: input.kind,
      unitPriceCny,
      quantity,
      rooms,
      costPriceCny,
    });
    const created = await tx.orderItem.create({
      data: {
        orderId,
        kind: input.kind === 'VISA' ? OrderItemKind.VISA : OrderItemKind.HOTEL,
        description,
        quantity,
        unitPrice: new Prisma.Decimal(unitPriceCny),
        amount: new Prisma.Decimal(priced.amount),
        unitCostCny: priced.unitCostCny == null ? null : new Prisma.Decimal(priced.unitCostCny),
        totalCostCny: priced.totalCostCny == null ? null : new Prisma.Decimal(priced.totalCostCny),
        hotelRoomTypeId: input.kind === 'HOTEL' ? input.hotelRoomTypeId : null,
        hotelCheckIn,
        hotelCheckOut,
        visaId: input.kind === 'VISA' ? input.visaId : null,
        visaIntendedDate,
        roomsBilled: input.kind === 'HOTEL' ? new Prisma.Decimal(rooms!) : null,
        metadata: {
          source: 'ORDER_GROUND_ITEM',
          note: input.note ?? null,
        } as Prisma.InputJsonValue,
      },
    });

    // 新增 VISA 行按建单时相同的乘客级口径补建任务；任务挂在新行上，默认 PENDING。
    if (input.kind === 'VISA') {
      const passengers = await tx.passenger.findMany({
        where: { orderId },
        select: { visaExempt: true },
      });
      if (
        orderNeedsVisaTask({
          visaStatus: order.visaStatus,
          hasVisaScope: true,
          passengers,
        })
      ) {
        await tx.fulfillmentTask.create({
          data: {
            orderItemId: created.id,
            type: FulfillmentType.VISA_APPLICATION,
            status: FulfillmentStatus.PENDING,
          },
        });
        visaTaskCreated = true;
      }
    }

    // 已过 PAID 履约生成点的订单（非待付款）：幂等补建新行的履约任务——
    // 否则付款后补录的房费行没有 HOTEL_BOOKING 任务，履约视图看不见它。
    // createFulfillmentTasks 按 item×类型跳过已有活动任务，VISA 分支刚建的任务不会重复。
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      await createFulfillmentTasks(tx, orderId);
    }

    const newSubtotal = round2(
      order.items.reduce((sum, item) => sum + Number(item.amount.toString()), 0) + priced.amount,
    );
    await tx.order.update({
      where: { id: orderId },
      data: {
        subtotal: new Prisma.Decimal(newSubtotal),
        total: new Prisma.Decimal(newSubtotal),
      },
    });

    // 按人份额落库（R1）：本事务改了应收 / 行金额，提交前把每人份额重算落库（写点见 service/passenger-shares.ts）。
    await persistPassengerShares(tx, orderId);
    return {
      orderNumber: order.orderNumber,
      itemId: created.id,
      kind: input.kind,
      productId: input.kind === 'VISA' ? input.visaId : input.hotelRoomTypeId,
      amountCny: priced.amount,
      unitPriceCny,
      unitCostCny: priced.unitCostCny,
      totalCostCny: priced.totalCostCny,
      visaTaskCreated,
    };
  });

  const finalOrder = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: ORDER_FULL_INCLUDE,
  });
  return {
    order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
    audit: scratch,
  };
}

export async function addRoomSupplement(
  svc: OrderService,
  orderId: string,
  input: {
    perNightCny: number;
    nights: number;
    note?: string;
    idempotencyKey?: string;
    passengerId?: string;
  },
  actor: { userId: string; role: UserRole },
): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      itemId: string;
      perNightCny: number;
      nights: number;
      amountCny: number;
      before: { subtotal: string; total: string };
      after: { subtotal: string; total: string };
      note?: string;
      /** A15 房控联动结果说明（未传 passengerId / 幂等回放时为 null）。*/
      roomControl: string | null;
    };
  }> {
  if (!actorCan(actor, 'orders.hotel.write')) {
    throw new ForbiddenError('仅运营/管理员可补收单房差');
  }
  const { perNightCny, nights } = input;
  const amount = perNightCny * nights;
  const row = buildRoomSupplementItem(input);

  const scratch = await prisma.$transaction(async (tx) => {
    // 行锁：先锁住订单行，串行化并发补房差。否则两个并发请求各读旧 items、各加一条 FEE、
    // 各按「旧合计 + 一次房差」写 total → 丢失更新（两条 FEE 行，但 total 只含一条）。
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

    // 幂等回放：同 idempotencyKey 已入账（双击/超时重发）→ 直接返回当时结果，绝不二次追加 FEE。
    if (input.idempotencyKey) {
      const dup = await tx.orderItem.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: { id: true, orderId: true },
      });
      if (dup) {
        if (dup.orderId !== orderId) {
          throw new BadRequestError('幂等键已用于其它订单，不能复用');
        }
        const cur = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { orderNumber: true, subtotal: true, total: true },
        });
        // 回放：金额不变（before === after），审计流水不重复追加。
        return {
          orderNumber: cur.orderNumber,
          itemId: dup.id,
          beforeSubtotal: cur.subtotal.toString(),
          beforeTotal: cur.total.toString(),
          afterSubtotal: cur.subtotal.toString(),
          afterTotal: cur.total.toString(),
          roomControl: null, // 回放：首次调用已完成房控联动，不重复
        };
      }
    }

    // items 在 FOR UPDATE 之后读取 → 看到的是已提交状态（含前一并发请求刚落的 FEE 行），
    // 据此重聚合 total，杜绝「基于锁前陈旧快照重算」的错账。
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        deletedAt: true,
        subtotal: true,
        total: true,
        adjustments: true,
        items: { select: { id: true, kind: true, amount: true } },
      },
    });
    if (!order) throw new NotFoundError('订单不存在');
    // 资金闸：补房差新增 FEE 行并抬高 order.total —— total 正是应退额与取消手续费的计算基数。
    // 已取消/已退款/支付超时/草稿/回收站的单若还能补收，等于给死单凭空加应收：
    // 已退款单被抬高 total 后可再算出一笔"应退"，形成二次退款。
    assertOrderAcceptsFunds(order);

    // 仅含 BUNDLE/HOTEL 行的订单可补收单房差（纯机票单无住宿 → 拒绝）。
    const hasStay = order.items.some(
      (it) => it.kind === OrderItemKind.HOTEL || it.kind === OrderItemKind.BUNDLE,
    );
    if (!hasStay) {
      throw new BadRequestError('该订单不含酒店/套餐行，无法补收单房差');
    }

    // ── 0. 房控联动（A15，2026-07-17 拍板：带 passengerId 的编辑住宿通道）────────────
    // 收钱的同时把「谁转单住」落到库存侧：Passenger.singleRoom=true + 套餐行 roomsBilled
    // 按权威公式重算。房控销控板/分房/超卖提醒全是派生账（每次现查订单），这两个字段
    // 一更新即自动跟上 —— 房量不够时提醒线会自动亮「该加房」，无需在此另设闸。
    let roomControl: string | null = null;
    // 补房差 FEE 行的成本口径（毛利真账）：默认 0（无增房 = 只收差价不产生房成本）。
    // 仅在套餐行计费房数真正上调（新增房间）时，按每晚成本 × 晚数 × 新增房数落实成本。
    let feeTotalCostCny = 0;
    let feeCostSource: RoomCostSource = 'ZERO';
    if (input.passengerId) {
      const pax = await tx.passenger.findUnique({
        where: { id: input.passengerId },
        select: { id: true, orderId: true, fullName: true, singleRoom: true },
      });
      if (!pax || pax.orderId !== orderId) {
        throw new BadRequestError('指定的乘客不存在或不属于本订单');
      }
      if (pax.singleRoom) {
        throw new BadRequestError(`乘客 ${pax.fullName} 已是单人入住，请勿重复补收单房差`);
      }
      await tx.passenger.update({
        where: { id: pax.id },
        data: { singleRoom: true },
      });
      roomControl = `乘客 ${pax.fullName} 已标记单人入住`;

      // 套餐行：按权威公式重算计费房数（独住者各占一间；只升不降，防误缩）。
      // 纯 HOTEL 行的房数由运营在分房里直接管理，这里只落 singleRoom 标记。
      const bundleItem = await tx.orderItem.findFirst({
        where: { orderId, kind: OrderItemKind.BUNDLE },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          metadata: true,
          roomsBilled: true,
          // 下单时的每间每晚成本快照（BUNDLE 行建单未快照 → null，回退现行房型成本价）。
          unitCostCny: true,
          bundle: {
            select: {
              hotelRoomTypeId: true,
              hotelRoomType: { select: { maxAdults: true, maxChildren: true, costPriceCny: true } },
            },
          },
        },
      });
      if (bundleItem?.bundle) {
        const newSingleCount = await tx.passenger.count({
          where: { orderId, singleRoom: true },
        });
        const occupancy = resolveBundleOccupancy({
          metadata: (bundleItem.metadata ?? {}) as Record<string, unknown>,
        });
        const roomsCharged = computeBundleRoomsCharged({
          occupancy,
          capacity: bundleItem.bundle.hotelRoomType,
          hotelRoomTypeId: bundleItem.bundle.hotelRoomTypeId,
          singleCount: newSingleCount,
          clientRoomsBilled: undefined,
        });
        const before = bundleItem.roomsBilled == null ? null : Number(bundleItem.roomsBilled.toString());
        if (before == null || roomsCharged > before) {
          await tx.orderItem.update({
            where: { id: bundleItem.id },
            data: { roomsBilled: new Prisma.Decimal(roomsCharged) },
          });
          // 新增计费房数 = 新旧 roomsBilled 之差（旧值未设时保守取 0，基线未知不虚构成本）。
          // 每晚成本三级回退：套餐行下单快照 → 现行房型成本价 → 0。晚数与描述里的 N 同源。
          const addedRooms = before == null ? 0 : Math.max(0, roomsCharged - before);
          const resolvedCost = resolveRoomSupplementCost({
            snapshotUnitCostCny:
              bundleItem.unitCostCny != null ? Number(bundleItem.unitCostCny.toString()) : null,
            productCostPriceCny:
              bundleItem.bundle.hotelRoomType?.costPriceCny != null
                ? Number(bundleItem.bundle.hotelRoomType.costPriceCny.toString())
                : null,
            nights,
            addedRooms,
          });
          feeTotalCostCny = resolvedCost.totalCostCny;
          feeCostSource = resolvedCost.costSource;
          roomControl += `；套餐行计费房数 ${before ?? '未设'} → ${roomsCharged}（房控/分房自动跟进）`;
        } else {
          roomControl += `；计费房数维持 ${before}（权威重算 ${roomsCharged} 未超过现值，只升不降）`;
        }
      } else {
        roomControl += '；本单为酒店行订单，房数请在分房面板调整（单住标记已生效）';
      }
    }

    // ── 1. 新增一条 FEE 调整行（描述含 ¥X/晚 × N晚，metadata 记 perNightCny/nights + costSource）──
    // 成本口径（Task A）：新增计费房数 × 每晚成本 × 晚数，随行落 totalCostCny（毛利真账）。
    // 无增房或无成本数据 → 0，costSource='ZERO'。原酒店/套餐行的成本快照一个字不动。
    const created = await tx.orderItem.create({
      data: {
        orderId,
        kind: OrderItemKind.FEE,
        description: row.description,
        quantity: 1,
        unitPrice: new Prisma.Decimal(row.unitPrice),
        amount: new Prisma.Decimal(row.amount),
        totalCostCny: new Prisma.Decimal(feeTotalCostCny),
        metadata: { ...row.metadata, costSource: feeCostSource } as Prisma.InputJsonValue,
        // 挂到转单住的那位乘客：这行带 priceAdjustment=true，不挂人会被每人结算价
        //（groupPassengerAdjustments）当整单调价摊给全员；导出「单房差」列也按它归属到人。
        // 未指定乘客（老入口/整单补收）→ null，仍走整单口径。
        passengerId: input.passengerId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });

    // ── 2. 用所有既有行 + 新行重算 subtotal/total（当前无 taxes/discount，total = subtotal）──
    const newSubtotal = round2(
      order.items.reduce((sum, it) => sum + Number(it.amount.toString()), 0) + amount,
    );
    const newTotal = newSubtotal;

    // ── 3. 审计流水（appendAdjustment；仅记录用，钱走上面的 total，不进 adjustmentCny）──
    const log = appendAdjustment(order.adjustments, {
      type: 'ROOM_SUPPLEMENT',
      label: row.description,
      amountCny: amount,
      at: new Date().toISOString(),
      by: actor.userId,
      note: input.note,
    });

    await tx.order.update({
      where: { id: orderId },
      data: {
        subtotal: new Prisma.Decimal(newSubtotal),
        total: new Prisma.Decimal(newTotal),
        adjustments: log,
      },
    });

    // 按人份额落库（R1）：本事务改了应收 / 行金额，提交前把每人份额重算落库（写点见 service/passenger-shares.ts）。
    await persistPassengerShares(tx, orderId);
    return {
      orderNumber: order.orderNumber,
      itemId: created.id,
      beforeSubtotal: order.subtotal.toString(),
      beforeTotal: order.total.toString(),
      afterSubtotal: newSubtotal.toString(),
      afterTotal: newTotal.toString(),
      roomControl,
    };
  });

  const finalOrder = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: ORDER_FULL_INCLUDE,
  });

  return {
    // 显式按角色推导序列化口径（本入口已断言 ADMIN/STAFF → 保留护照大图，与补收前的返回一致）。
    // serializeOrder 的护照大图缺省是 fail-closed，不显式传 ctx 会静默剥掉后台需要的缩略图。
    order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
    audit: {
      orderNumber: scratch.orderNumber,
      itemId: scratch.itemId,
      perNightCny,
      nights,
      amountCny: amount,
      before: { subtotal: scratch.beforeSubtotal, total: scratch.beforeTotal },
      after: { subtotal: scratch.afterSubtotal, total: scratch.afterTotal },
      note: input.note,
      roomControl: scratch.roomControl,
    },
  };
}

// ════════════════════════════════════════════════════════════════════
// 售后改单：套餐改档（POST /orders/:id/change-bundle · ADMIN/STAFF）
//
// 行业口径 = amendment：**改档 → 按新档重新计价 → 差价入账 → 审计**。
// 数据模型上「档次」不是套餐的一个可改字段，而是另一条 Bundle 记录
// （settlementTier / settlementNights 都挂在 Bundle 上），所以改档 = 把订单的 BUNDLE 行换绑。
// 此前系统没有这个动作：运营只能「换酒店 + 手工调价」拼出来，钱与货各改各的、对不上账。
//
// 定价哲学（与换酒店 / 酒店改期同一套）：**行价冻结 + 差额入账**。
//   · BUNDLE 行只换绑（bundleId / 行描述 / 随档次派生的住宿区间与间数），金额一个字不动；
//   · 「新应收 − 原应收」落一条 bundleChange 差额行（正=补收、负=优惠），
//     订单 subtotal/total 按 Σ items 收敛；
//   · **已收款项一分不动** —— 尾款/多收自然浮动（应付 = total + adjustmentCny，收款账不参与）。
//
// 新应收的两条取价通道（与录单完全同源，不另起炉灶）：
//   a) 代理单 + 新套餐配了结算价日历键（档次 + 晚数）→ 走结算价日历：
//      每人价（新档 × 新晚数 × 本单去程出发日）× 人数 + 加项净额 − 命中的代理立减；
//      取不到当日价 → 拒单（口径同录单：宁可不改，也不按错价成交）。
//   b) 其余 → 本地权威价管道：新套餐地面价 + 加项 + 操作费，再按新套餐 discountPct 打折；
//      新应收 = 原应收 + （新套餐行价 − 旧套餐行价）。
//
// 硬边界（改档不碰的东西）：
//   · 机票行 / 班次 / 座位一律不动 —— 改档不改航班，绝不在此触碰任何占座链路；
//   · 升舱行若与旧套餐档次绑定，同样保持不动（响应 warnings 提示人工复核）；
//   · 指定酒店及其加价随本次改档清除（新档的酒店要重新指定，响应 warnings 提示）。
// ════════════════════════════════════════════════════════════════════
export async function changeOrderBundle(
  svc: OrderService,
  orderId: string,
  input: ChangeOrderBundleBody,
  actor: { userId: string; role: UserRole },
): Promise<{
    order: ReturnType<typeof serializeOrder>;
    audit: {
      orderNumber: string;
      orderItemId: string;
      before: {
        bundleId: string;
        bundleName: string | null;
        settlementTier: SettlementTier | null;
        settlementNights: number | null;
        total: string;
      };
      after: {
        bundleId: string;
        bundleName: string | null;
        settlementTier: SettlementTier | null;
        settlementNights: number | null;
        total: string;
      };
      diffCny: number;
      diffItemId: string | null;
      pricingSource: 'SETTLEMENT_CALENDAR' | 'BUNDLE_PRICE';
      note: string | null;
      warnings: string[];
    };
  }> {
  if (!actorCan(actor, 'orders.change_bundle')) {
    throw new ForbiddenError('仅运营/管理员可更改套餐档次');
  }
  const note = input.note?.trim() || null;

  // ── 0. 事务外只读预检（只为「明显不该改的单别开事务」快速失败）───────────
  // 这里读到的一切都只是**预检**：状态、明细、总额都可能在开事务前被并发操作改掉。
  // 权威判定（状态 / 落位 / 计价 / 房量）一律在下面的行锁内、基于锁后重读的快照重做一遍，
  // 锁外算出来的钱一分都不落库 —— 否则改档窗口期内的并发调价会被差额行静默抵消。
  const preview = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      deletedAt: true,
      items: { select: CHANGE_BUNDLE_ITEM_SELECT },
    },
  });
  if (!preview) throw new NotFoundError('订单不存在');
  assertOrderChangeBundleAllowed(preview);
  const previewPick = resolveChangeableBundleRow(preview.items, input.bundleId);

  const newBundle = await prisma.bundle.findUnique({
    where: { id: input.bundleId },
    select: CHANGE_BUNDLE_PRICING_SELECT,
  });
  if (!newBundle) throw new NotFoundError(`套餐 ${input.bundleId} 不存在`);
  if (!newBundle.isActive) throw new BadRequestError('目标套餐已下架');
  const oldBundle = await prisma.bundle.findUnique({
    where: { id: previewPick.bundleId },
    select: { id: true, name: true, settlementTier: true, settlementNights: true },
  });

  // ── 1. 事务：锁 → 重读 → 计价 → 房量闸 → 换绑 + 差额行 + 总额收敛 + 签证任务对齐 ──
  const scratch = await prisma.$transaction(async (tx) => {
    // 行锁：与换酒店/换人/调价同一份读-改-写（total / 差额行），必须串行。
    const lockRows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
    `;
    if (lockRows.length === 0) throw new NotFoundError('订单不存在');

    const locked = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        deletedAt: true,
        agentId: true,
        subtotal: true,
        total: true,
        adjustments: true,
        items: { select: CHANGE_BUNDLE_ITEM_SELECT },
      },
    });
    if (!locked) throw new NotFoundError('订单不存在');
    // 锁后复检（读的是刚 FOR UPDATE 的那一行，与并发状态流转严格串行）。
    assertOrderAcceptsFunds(locked);
    assertOrderChangeBundleAllowed(locked);
    // 明细同样锁后重挑：并发可能已经改过档、已落位、或加了第二条套餐行。
    const { row: bundleRow, bundleId: fromBundleId } = resolveChangeableBundleRow(
      locked.items,
      input.bundleId,
    );
    // CAS：锁前预检看到的那条行若已被并发操作换掉，本次就是在另一张套餐上做决定 → 让调用方重试。
    if (bundleRow.id !== previewPick.row.id || fromBundleId !== previewPick.bundleId) {
      throw new ConflictError('该订单的套餐行已被其他操作更改，请刷新后重试');
    }

    // ── 计价输入：一律沿用**锁内快照**里已盖章的数，保证差额只反映「档次变了」这一件事 ──
    // 优先级：行 metadata.addOns（下单时的权威重算快照，含三计数 / 单住 / 分程升舱 / 自备签人数）
    //        → metadata / quantity 的旧口径回落（老单没有 addOns 快照时）。
    const rowMetadata = (bundleRow.metadata ?? {}) as Record<string, unknown>;
    const addOnSnapshot = rowMetadata.addOns as Partial<BundleAddOnBreakdown> | undefined;
    const occupancy =
      addOnSnapshot && typeof addOnSnapshot.adultCount === 'number'
        ? resolveBundleOccupancy({
            adultCount: addOnSnapshot.adultCount,
            childCount: addOnSnapshot.childCount ?? 0,
            infantCount: addOnSnapshot.infantCount ?? 0,
            quantity: bundleRow.quantity,
          })
        : resolveBundleOccupancy({ quantity: bundleRow.quantity, metadata: rowMetadata });
    const singleCount = Math.max(0, Math.trunc(Number(addOnSnapshot?.singleCount ?? 0) || 0));
    const selfProvidedVisaCount = Math.max(
      0,
      Math.trunc(Number(addOnSnapshot?.selfProvidedVisaCount ?? 0) || 0),
    );
    const businessSplit: BundleBusinessUpgradeSplit = {
      outbound: Math.max(0, Math.trunc(Number(addOnSnapshot?.businessCountOutbound ?? 0) || 0)),
      return: Math.max(0, Math.trunc(Number(addOnSnapshot?.businessCountReturn ?? 0) || 0)),
    };

    // 出发日：整单口径（最早航段的出发地当地日 → 酒店入住日 → 签证预计出行日），与列表列同源。
    const departYmd = deriveOrderDepartDate(
      locked.items as unknown as Array<Record<string, unknown>>,
    );

    // 自备签减免单一配置源：null = 跟随签证组件产品价（与录单计价同一解析，改档不例外）。
    const changedSelfVisaDeductCny = await resolveSelfVisaDeductCny(newBundle, tx);
    const priced = computeChangedBundleLine({
      bundle: { ...newBundle, selfVisaDeductCny: changedSelfVisaDeductCny },
      occupancy,
      singleCount,
      businessSplit,
      selfProvidedVisaCount,
      quantity: bundleRow.quantity,
      goDate: departYmd,
    });

    // ── 新应收 ───────────────────────────────────────────────────────────
    // 旧档的**有效金额** = 冻结的套餐行金额 + 历次改档差额行合计。
    // 行价冻结意味着套餐行金额永远停在首次录单那一刻，只看它当基线会让第二次改档
    // 把上一次的差额再算一遍（A→B 留 +200 后，B→C 会按 A 的价算成 C−A，凭空多收 200）。
    // 把既有差额行加回来，基线才是「这条套餐行现在实际贡献了多少应收」，
    // 于是任意次改档后的总额恒等于「按当前档从头录单」的应收。
    const frozenBundleAmountCny = Number(bundleRow.amount.toString());
    const priorBundleChangeCny = sumBundleChangeDiffCny(locked.items);
    const effectiveOldBundleCny = round2(frozenBundleAmountCny + priorBundleChangeCny);
    // 总额基准取锁内值：并发调价改动的那部分留在总额里往前带，绝不被差额行抵消掉。
    const lockedTotalCny = Number(locked.total.toString());
    let pricingSource: 'SETTLEMENT_CALENDAR' | 'BUNDLE_PRICE' = 'BUNDLE_PRICE';
    let newTotalCny = round2(lockedTotalCny + (priced.amount - effectiveOldBundleCny));
    // 人工复核提示（不阻断，随响应回给运营）。
    const warnings: string[] = [];
    // 目标套餐的航线从其绑定航班派生（bundle-route.ts 唯一入口）：配了日历键却没绑航班 = 没有航线，
    // 不取日历价（绝不兜底到某条既有航线），本次按套餐价计并提示运营——与录单侧「不取、不报错」同口径。
    const newBundleRouteKey = bundleRouteKey(newBundle);
    if (
      locked.agentId &&
      newBundle.settlementTier != null &&
      newBundle.settlementNights != null &&
      newBundleRouteKey == null
    ) {
      warnings.push(
        '目标套餐已配置结算价日历但未绑定航班，无法确定航线取价：本次按套餐价计，请核对后手工调价，或先给套餐绑定航班再改档',
      );
    }
    if (
      locked.agentId &&
      newBundle.settlementTier != null &&
      newBundle.settlementNights != null &&
      newBundleRouteKey != null
    ) {
      if (!departYmd) {
        throw new BadRequestError(
          '目标套餐已配置结算价日历，但本单无法确定出发日期取价，请先补全航段或联系运营',
        );
      }
      const rate = await getSettlementRate(
        newBundleRouteKey,
        newBundle.settlementTier,
        newBundle.settlementNights,
        departYmd,
      );
      if (!rate) {
        throw new BadRequestError('该出发日期在目标档次下的结算价未维护，请联系运营');
      }
      // 日历价是「基础随机套餐」的每人同业价，加项按报价口径叠加其上（与录单 resolveBundleSettlementCalendarTotal
      // 完全同一公式）。指定酒店加价已随改档清除，故此处加项净额只有 addOn.total。
      let calendarTotal = round2(
        rate.pricePerPersonCny * occupancy.headCount + priced.settlementAddOnCny,
      );
      const discountHit = await resolveAgentSettlementDiscount(
        locked.agentId,
        newBundleRouteKey,
        newBundle.settlementTier,
        newBundle.settlementNights,
        departYmd,
      );
      if (discountHit) {
        calendarTotal = round2(
          calendarTotal - discountHit.discountPerPersonCny * occupancy.headCount,
        );
      }
      if (calendarTotal <= 0) {
        throw new BadRequestError('按目标档次取价后的结算价异常（≤0），请检查结算价日历与立减规则');
      }
      // 日历通道是**绝对**口径：日历价就是「本单最终收多少钱」（与录单的结算价收敛完全同源），
      // 因此天然与改档次数无关，重复改档不会叠加差额。
      pricingSource = 'SETTLEMENT_CALENDAR';
      newTotalCny = calendarTotal;
    }

    const diffCny = round2(newTotalCny - lockedTotalCny);
    if (Math.abs(diffCny) > PRICE_ADJUSTMENT_CAP_CNY) {
      throw new BadRequestError(
        `改档差额 ¥${Math.abs(diffCny)} 超出调价上限（±¥${PRICE_ADJUSTMENT_CAP_CNY}），请复核目标套餐与结算价`,
      );
    }
    if (rowMetadata.designatedHotel) {
      warnings.push('原「指定酒店」及其加价已随本次改档清除，请按新档次重新指定酒店');
    }
    if ((businessSplit.outbound ?? 0) > 0 || (businessSplit.return ?? 0) > 0) {
      warnings.push('本单含升舱，升舱行与占座一律未改动，请人工复核升舱差价是否仍适用新档次');
    }
    if (!priced.hotelStamp && newBundle.hotelRoomTypeId) {
      warnings.push('未能推导出新的住宿区间（缺出发日期），住宿日期未盖章，请人工补录');
    }
    // 房量变化提示：改档按新档次的容量重算 roomsBilled（priced.rooms 按人头算整间），
    // 拆单/分房留下的半间会被这一步抹平 —— 房控板上的占用会跟着跳，房控得知道为什么。
    const roomsBeforeChange = bundleRow.roomsBilled == null ? null : Number(bundleRow.roomsBilled);
    if (roomsBeforeChange != null && Math.abs(roomsBeforeChange - priced.rooms) > 1e-9) {
      warnings.push(
        `本单套餐行占房由 ${roomsBeforeChange} 间改为 ${priced.rooms} 间（按新档次容量重算，` +
          '拆单/分房留下的半间会被抹平）：请知会房控核对该酒店该日期的房量。',
      );
    }
    // 改档只换套餐档次与钱，不碰航段事实：去程真没飞就是没飞，标记原样留着。
    if (
      locked.items.some(
        (it) =>
          it.kind === OrderItemKind.FLIGHT &&
          readJsonObject(readJsonObject(it.metadata).noShow).at != null,
      )
    ) {
      warnings.push('本单去程已标记 no-show，改档不改变这一事实：该标记与回程座位状态原样保留');
    }

    // ── 1a. 房量闸（与录单同款，事务内带行锁）──────────────────────────────
    // 改档会把套餐行的占房整体换成新档的房型/区间/间数 —— 那是一笔真真切切的新增占房，
    // 此前一道闸都没有：新档满房照样落库，销控板直接变负。
    // 判定口径 = 「先释放本单现有占房，再把改档后的整单占房加回去」：
    //   · excludeOrderId 排除本单在库的旧占房；
    //   · prospective 里既有换绑后的套餐行，也有本单其余占房行（被 exclude 排掉了，必须补回来），
    //     否则等于把自己已占的房当成空房，会放行超卖。
    // 两道闸互补：真酒店走物理房间闸，未落位随机档走同星级聚合闸，各自跳过不归自己管的行。
    // 补回来的那几行都是未落位行（真酒店行早被上面的已落位闸拒在门外），按床位口径合计，
    // 与它们留在库里被算作存量占房时的口径一致。
    const prospectiveStays: ProspectiveHotelStay[] = [
      {
        hotelRoomTypeId: priced.hotelStamp?.hotelRoomTypeId ?? null,
        hotelCheckIn: priced.hotelStamp?.hotelCheckIn ?? null,
        hotelCheckOut: priced.hotelStamp?.hotelCheckOut ?? null,
        roomsBilled: priced.rooms,
      },
      ...locked.items
        .filter((it) => it.id !== bundleRow.id)
        .map((it) => ({
          hotelRoomTypeId: it.hotelRoomTypeId,
          hotelCheckIn: it.hotelCheckIn,
          hotelCheckOut: it.hotelCheckOut,
          roomsBilled: it.roomsBilled == null ? null : Number(it.roomsBilled.toString()),
          randomStarTier: it.randomStarTier,
        })),
    ];
    const orderPassengers = await tx.passenger.findMany({
      where: { orderId },
      select: { gender: true },
    });
    const passengerGenders = orderPassengers.map((p) => ({ gender: p.gender ?? undefined }));
    // 后台端点 → 用默认的带数字文案（运营要看得见差多少间），不套对外中性话术。
    await assertHotelStaysFitWithinTx(tx, prospectiveStays, passengerGenders, {
      excludeOrderId: orderId,
    });
    await assertRandomTierStaysFitWithinTx(tx, prospectiveStays, {
      excludeOrderId: orderId,
      maxOversellRooms: RANDOM_TIER_INTERNAL_NO_CAP,
    });

    // 1b. 套餐行换绑（金额冻结；只改「买的是哪张套餐」与随档次派生的住宿字段）。
    //     指定酒店留痕从 metadata 里摘掉 —— 那是旧档次下的选择，新档要重新指定。
    const {
      designatedHotel: _clearedDesignatedHotel,
      ...metadataWithoutDesignated
    } = rowMetadata as Record<string, unknown> & { designatedHotel?: unknown };
    await tx.orderItem.update({
      where: { id: bundleRow.id },
      data: {
        bundleId: newBundle.id,
        description: newBundle.name,
        // 未落位随机档：房型跟着新套餐走（新套餐没绑房型 → 清空，等房控落位）。
        hotelRoomTypeId: priced.hotelStamp?.hotelRoomTypeId ?? null,
        hotelCheckIn: priced.hotelStamp?.hotelCheckIn ?? null,
        hotelCheckOut: priced.hotelStamp?.hotelCheckOut ?? null,
        // 房控是派生账：新档的容量/晚数变了，占房必须跟着变，否则销控板与真账分叉。
        roomsBilled: new Prisma.Decimal(priced.rooms),
        metadata: {
          ...metadataWithoutDesignated,
          roomsNeeded: priced.rooms,
          addOns: priced.addOn.breakdown,
          // 改档留痕（旧档 → 新档、取价来源、差额、原因）：这一行为什么现在长这样，看它就够了。
          bundleChange: {
            fromBundleId,
            fromBundleName: oldBundle?.name ?? null,
            fromSettlementTier: oldBundle?.settlementTier ?? null,
            fromSettlementNights: oldBundle?.settlementNights ?? null,
            toBundleId: newBundle.id,
            toBundleName: newBundle.name,
            toSettlementTier: newBundle.settlementTier ?? null,
            toSettlementNights: newBundle.settlementNights ?? null,
            pricingSource,
            diffCny,
            reasonText: note,
            at: new Date().toISOString(),
            by: actor.userId,
          },
        } as unknown as Prisma.InputJsonValue,
      },
    });

    // 1c. 差额行（正=补收 FEE、负=优惠 DISCOUNT）。差额为 0 时不建行（改档本身仍留审计）。
    let diffItemId: string | null = null;
    if (diffCny !== 0) {
      const signed = `${diffCny > 0 ? '+' : '−'}¥${Math.abs(diffCny)}`;
      const created = await tx.orderItem.create({
        data: {
          orderId,
          kind: diffCny > 0 ? OrderItemKind.FEE : OrderItemKind.DISCOUNT,
          description:
            `套餐改档差额：${oldBundle?.name ?? '原套餐'} → ${newBundle.name}（${signed}）` +
            (note ? `：${note}` : ''),
          quantity: 1,
          unitPrice: new Prisma.Decimal(diffCny),
          amount: new Prisma.Decimal(diffCny),
          // 纯价格调整行无采购成本 → 显式落 0（口径同 buildPriceAdjustmentItem），不留 NULL 污染毛利。
          totalCostCny: new Prisma.Decimal(0),
          metadata: {
            // priceAdjustment 标：让「按乘客/整单调整明细」等既有展示口径认得这一行。
            priceAdjustment: true,
            // bundleChange: true 是**差额行的身份标**：下一次改档要靠它把历次差额加回基线。
            bundleChange: true,
            reasonCode: 'SETTLEMENT',
            reasonText: note,
            fromBundleId,
            toBundleId: newBundle.id,
            pricingSource,
          } as Prisma.InputJsonValue,
        },
      });
      diffItemId = created.id;
    }

    // 1d. 总额收敛：subtotal/total = Σ 所有行金额（含刚换绑的套餐行与差额行）。
    //     已收款一分不动 —— 尾款/多收由「应付 − 已收」自然浮动。
    const sumAfter = await tx.orderItem.aggregate({
      where: { orderId },
      _sum: { amount: true },
    });
    const newSubtotal = round2(Number(sumAfter._sum.amount?.toString() ?? '0'));
    const log = appendAdjustment(locked.adjustments, {
      type: 'BUNDLE_CHANGE',
      label: `套餐改档：${oldBundle?.name ?? '原套餐'} → ${newBundle.name}`,
      amountCny: diffCny,
      at: new Date().toISOString(),
      by: actor.userId,
      reasonCode: 'SETTLEMENT',
      ...(note ? { note } : {}),
    });
    await tx.order.update({
      where: { id: orderId },
      data: {
        subtotal: new Prisma.Decimal(newSubtotal),
        total: new Prisma.Decimal(newSubtotal),
        adjustments: log,
      },
    });

    // 1e. 签证任务对齐：含签证套餐 ↔ 不含签证套餐互改后，任务必须跟着增撤。
    //     任务是需求的派生物 —— 不同步的话，要么签证台上挂着一条永远办不掉的「待处理」，
    //     要么整单漏掉本该办的签证。放在换绑之后调用，它读到的就是新档。
    const visaSync = await syncVisaTasksForOrder(tx, orderId, {
      userId: actor.userId,
      role: actor.role,
    });
    if (visaSync.cancelledTaskIds.length > 0) {
      warnings.push('新档次不涉及签证，本单原「待处理」签证任务已自动撤销');
    }
    if (visaSync.createdTaskIds.length > 0) {
      warnings.push('新档次含签证，已自动补建一条「待处理」签证任务');
    }

    // 按人份额落库（R1）：本事务改了应收 / 行金额，提交前把每人份额重算落库（写点见 service/passenger-shares.ts）。
    await persistPassengerShares(tx, orderId);
    return {
      orderNumber: locked.orderNumber,
      beforeTotal: locked.total.toString(),
      afterTotal: newSubtotal.toString(),
      diffCny,
      diffItemId,
      pricingSource,
      warnings,
    };
  });

  const finalOrder = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: ORDER_FULL_INCLUDE,
  });

  return {
    order: serializeOrder(finalOrder, orderSerializeRoleCtx(actor.role)),
    audit: {
      orderNumber: scratch.orderNumber,
      orderItemId: previewPick.row.id,
      before: {
        bundleId: previewPick.bundleId,
        bundleName: oldBundle?.name ?? null,
        settlementTier: oldBundle?.settlementTier ?? null,
        settlementNights: oldBundle?.settlementNights ?? null,
        total: scratch.beforeTotal,
      },
      after: {
        bundleId: newBundle.id,
        bundleName: newBundle.name,
        settlementTier: newBundle.settlementTier ?? null,
        settlementNights: newBundle.settlementNights ?? null,
        total: scratch.afterTotal,
      },
      diffCny: scratch.diffCny,
      diffItemId: scratch.diffItemId,
      pricingSource: scratch.pricingSource,
      note,
      warnings: scratch.warnings,
    },
  };
}

/**
 * 改档要读的订单明细字段。锁外预检与锁内权威判定**共用同一份 select** ——
 * 两处各写一套，迟早出现「预检按 A 组字段放行、锁内按 B 组字段算钱」的漂移。
 * 覆盖四件事：挑套餐行、判已落位、算出发日、算旧档有效金额与占房。
 */
export const CHANGE_BUNDLE_ITEM_SELECT = {
  id: true,
  kind: true,
  quantity: true,
  amount: true,
  bundleId: true,
  hotelRoomTypeId: true,
  hotelCheckIn: true,
  hotelCheckOut: true,
  roomsBilled: true,
  randomStarTier: true,
  visaIntendedDate: true,
  metadata: true,
  // 「已落位」判定：房型挂在随机档占位酒店上 = 还没落位（业务上仍是随机档）。
  hotelRoomType: { select: { hotel: { select: { name: true, randomTierPlaceholder: true } } } },
  // 整单出发日派生（deriveOrderDepartDate 同口径，按出发地当地日折算）。
  flightSchedule: { select: { departureTime: true, departureTz: true } },
} as const;

/** resolveChangeableBundleRow 认得的最小订单项形状（真实入参是上面 select 出来的行）。 */
export interface ChangeBundleCandidateRow {
  id: string;
  kind: OrderItemKind;
  bundleId: string | null;
  hotelRoomTypeId: string | null;
  hotelRoomType?: { hotel: { randomTierPlaceholder: number | null } } | null;
}

/**
 * 「这单现在还能不能改档」的状态闸。锁外预检与锁内复检共用。
 * 状态集合与换酒店 / 酒店改期同一份：改档会改应收（长出/减掉一笔差额），
 * 在已取消 / 已退款 / 超时 / 草稿单上做，等于给死单凭空改账、能被算出二次退款。
 */
export function assertOrderChangeBundleAllowed(order: {
  status: OrderStatus;
  deletedAt: Date | null;
}): void {
  if (order.deletedAt) {
    throw new BadRequestError('订单在回收站（已软删），不可改档；如需操作请先恢复');
  }
  if (!SEAT_HOLDING_STATUSES.includes(order.status)) {
    throw new BadRequestError(
      `订单当前状态（${zhStatus(order.status)}）不可改档：仅占座中的有效订单可改档（已取消/已退款/超时订单请勿改档）`,
    );
  }
}

/**
 * 从订单明细里挑出「唯一那条可改档的套餐行」，顺手把不该改的情况一次性拒掉：
 * 无套餐行 / 多条套餐行 / 未关联产品 / 与目标同档 / 酒店已落位。
 *
 * 已落位 = 住宿已盖章到**真实**酒店（房型所属酒店不是随机档占位酒店）。此时改档会让
 * 「客人已经确定住哪」与「新档次该住哪」直接打架 —— 住宿要先走换酒店流程处理掉，
 * 改档只负责钱与档次。未落位（仍是随机档占位）或无酒店组件才允许。
 *
 * 锁外预检与锁内权威判定共用本函数：并发可能在这两次之间把单改成任一种「不该改」，
 * 两处各写一套判定必然漂移。
 */
export function resolveChangeableBundleRow<T extends ChangeBundleCandidateRow>(
  items: readonly T[],
  targetBundleId: string,
): { row: T; bundleId: string } {
  const bundleRows = items.filter((it) => it.kind === OrderItemKind.BUNDLE);
  if (bundleRows.length === 0) {
    throw new BadRequestError('本单不含套餐行，无法改档');
  }
  if (bundleRows.length > 1) {
    // 多套餐单改档「改哪一张」无从判定，且差额口径会分叉 —— 明确拒绝，不猜。
    throw new BadRequestError('本单含多条套餐行，暂不支持自动改档，请联系技术处理');
  }
  const row = bundleRows[0];
  if (!row.bundleId) {
    throw new BadRequestError('该套餐行未关联套餐产品，无法改档');
  }
  if (row.bundleId === targetBundleId) {
    throw new BadRequestError('目标套餐与当前套餐相同，无需改档');
  }
  const isSettledRow = (candidate: ChangeBundleCandidateRow): boolean =>
    candidate.hotelRoomTypeId != null &&
    candidate.hotelRoomType?.hotel.randomTierPlaceholder == null;
  const settled =
    (isSettledRow(row) ? row : null) ??
    items.find((it) => it.kind === OrderItemKind.HOTEL && isSettledRow(it)) ??
    null;
  if (settled) {
    throw new BadRequestError('本单酒店已落位，请先通过换酒店功能处理住宿再改档');
  }
  return { row, bundleId: row.bundleId };
}

/**
 * 历次「套餐改档差额行」的合计（CNY，正=补收、负=优惠）。
 *
 * 用途：套餐行行价冻结（永远停在首次录单那一刻），所以「这条套餐行现在实际贡献了多少应收」
 * = 冻结金额 + 本函数。第二次改档必须拿这个数当旧档基线，否则会把上一次的差额再算一遍。
 *
 * 只认差额行：差额行是 FEE/DISCOUNT 且 `metadata.bundleChange === true`；
 * 套餐行自己的 `metadata.bundleChange` 是一个留痕**对象**（不是 true），故连 kind 一起卡，
 * 两者绝不会互相认错。导出供单测使用。
 */
export function sumBundleChangeDiffCny(
  items: ReadonlyArray<{ kind: OrderItemKind; amount: Prisma.Decimal | number; metadata: unknown }>,
): number {
  const total = items.reduce((sum, it) => {
    if (it.kind !== OrderItemKind.FEE && it.kind !== OrderItemKind.DISCOUNT) return sum;
    const meta = it.metadata as { bundleChange?: unknown } | null;
    if (meta?.bundleChange !== true) return sum;
    return sum + Number(it.amount.toString());
  }, 0);
  return round2(total);
}

/**
 * 改档重新计价所需的套餐字段（与录单 priceAndValidateItems 的 BUNDLE 分支同一组，
 * 少一个字段就会出现「录单算出一个价、改档算出另一个价」的漂移）。
 */
export const CHANGE_BUNDLE_PRICING_SELECT = {
  id: true,
  name: true,
  isActive: true,
  items: true,
  discountPct: true,
  hotelRoomTypeId: true,
  hotelNights: true,
  singleSupplementCnyPerNight: true,
  businessUpgradeCnyPerLeg: true,
  // 起降地一并取出：改档按目标套餐派生航线取结算价日历（bundle-route.ts）
  outboundFlight: {
    select: { businessUpgradeCnyPerLeg: true, originCode: true, destinationCode: true },
  },
  returnFlight: {
    select: { businessUpgradeCnyPerLeg: true, originCode: true, destinationCode: true },
  },
  childSeatDiscountCnyPerPerson: true,
  infantPriceCny: true,
  selfVisaDeductCny: true,
  operationFeeCny: true,
  legs: true,
  settlementTier: true,
  settlementNights: true,
  hotelRoomType: { select: { maxAdults: true, maxChildren: true, basePrice: true, hotelId: true } },
} as const;

/**
 * 套餐改档后的行价重算 —— 与录单 BUNDLE 分支共用同一批权威纯函数
 * （resolveBundleNights / computeBundleRoomsCharged / computeBundleGroundTotal /
 *   resolveBundleHotelStamp / computeBundleAddOn / computeBundleOperationFeeTotal），
 * 只是把「客户端传来的行输入」换成「原单已盖章的快照」。
 *
 * 与录单唯一的口径差异：**指定酒店加价恒为 0** —— 指定酒店随改档清除（新档要重新指定），
 * 这一点在 changeOrderBundle 的响应 warnings 里明确告知运营。
 *
 * 导出供单测使用。
 */
export function computeChangedBundleLine(input: {
  bundle: {
    items: unknown;
    discountPct: number | null;
    hotelRoomTypeId: string | null;
    hotelNights: number | null;
    singleSupplementCnyPerNight: number;
    businessUpgradeCnyPerLeg: number | null;
    outboundFlight?: { businessUpgradeCnyPerLeg: number } | null;
    returnFlight?: { businessUpgradeCnyPerLeg: number } | null;
    childSeatDiscountCnyPerPerson: number;
    infantPriceCny: number;
    selfVisaDeductCny: number;
    operationFeeCny: number;
    legs: number;
    hotelRoomType?: { maxAdults: number; maxChildren: number; basePrice: Prisma.Decimal | number } | null;
  };
  occupancy: BundleOccupancy;
  singleCount: number;
  businessSplit: BundleBusinessUpgradeSplit;
  selfProvidedVisaCount: number;
  quantity: number;
  /** 出发日（YYYY-MM-DD）；缺失 → 不盖住宿区间的章。 */
  goDate: string | null;
}): {
  /** 打折后的套餐行金额（CNY，整数，≥0）。 */
  amount: number;
  /** 打折后的套餐行单价（地面价口径）。 */
  unitPrice: number;
  rooms: number;
  nights: number;
  hotelStamp: { hotelRoomTypeId: string; hotelCheckIn: Date; hotelCheckOut: Date } | null;
  addOn: ReturnType<typeof computeBundleAddOn>;
  /** 加项净额（未打折）：结算价日历取价时叠加在日历价之上。 */
  settlementAddOnCny: number;
} {
  const { bundle, occupancy, singleCount, businessSplit, selfProvidedVisaCount, quantity } = input;
  const nights = resolveBundleNights(bundle.items, bundle.hotelNights);
  const rooms = computeBundleRoomsCharged({
    occupancy,
    capacity: bundle.hotelRoomType ?? null,
    hotelRoomTypeId: bundle.hotelRoomTypeId,
    singleCount,
    // 改档不接受客户端间数：新档的容量口径由新套餐房型决定，一律服务端重算。
    clientRoomsBilled: undefined,
  });
  const linkedHotelNightlyPrice =
    bundle.hotelRoomTypeId && bundle.hotelRoomType
      ? Number(bundle.hotelRoomType.basePrice.toString())
      : null;
  const visaHeadCount = Math.max(0, occupancy.headCount - selfProvidedVisaCount);
  const groundUnitPrice = computeBundleGroundTotal({
    components: bundle.items,
    linkedHotelNightlyPrice,
    rooms,
    visaHeadCount,
  });
  const hotelStamp = resolveBundleHotelStamp(
    { hotelRoomTypeId: bundle.hotelRoomTypeId },
    input.goDate ? { goDate: input.goDate } : undefined,
    nights,
  );
  const addOn = computeBundleAddOn(
    { ...bundle, businessUpgradeCnyPerLeg: resolveBundleBusinessUpgradeRate(bundle) },
    hotelStamp,
    singleCount,
    businessSplit,
    occupancy,
    nights,
    selfProvidedVisaCount,
  );
  const operationFeeTotal = computeBundleOperationFeeTotal(bundle.operationFeeCny, occupancy.seatPax);
  // 非负保护与录单同一层：减免（自备签/儿童折扣）先抵扣地面价 + 操作费，极端情况才夹到 0。
  let amount = Math.max(0, groundUnitPrice * quantity + addOn.total + operationFeeTotal);
  let unitPrice = groundUnitPrice;
  const pct = bundle.discountPct ?? 0;
  if (pct > 0) {
    const factor = (100 - pct) / 100;
    amount = Math.round(amount * factor);
    unitPrice = Math.round(unitPrice * factor);
  }
  return {
    amount,
    unitPrice,
    rooms,
    nights,
    hotelStamp,
    addOn,
    settlementAddOnCny: addOn.total,
  };
}
