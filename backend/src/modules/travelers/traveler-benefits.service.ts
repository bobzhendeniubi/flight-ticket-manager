/**
 * 常旅客权益核销台账 —— append-only 流水，永不删改。
 *
 * 口径（2026-09-21 拍板，推翻 09-11「可用 = 已飞 − 已核销」）：
 *   可用次数 availableTrips = 合计已飞 tripCount（含老系统历史飞行）
 *                           + 已付款在订未飞 pendingPaidTripCount（待支付 / 占位单不算）
 *                           − 本档案流水 sum(tripsUsed)（净额）
 *   全站唯一实现是下方 computeAvailableTrips；列表 / 联想 / 详情 / 核销闸 / 导出 / 提醒规则
 *   一律引用它，谁也不许再手写这道减法。
 *   核销 tripsUsed > 0（扣减可用次数）；录错走冲正（compensating entry）：
 *   插入一条 tripsUsed = −原值、reversalOfId 指向原条目的补偿流水，原条目原样留存。
 *   reversalOfId 唯一约束 ⇒ 一条核销最多冲正一次（并发下由数据库兜底）。
 *
 * 挂单号：核销可以挂它兑换的那张订单（orderId）。挂了单号的核销，订单落取消族终态
 * （取消 / 退款 / 支付超时 / 失败）或去程被标 no-show 时由系统自动追加负数补偿行
 * （见 traveler-benefits.auto-reverse.ts）；没挂单号的存量流水仍靠人工冲正。
 *
 * tripCount 是「新系统订单已飞 + 老系统历史飞行」的快照，退订/删单会让新系统部分掉下去
 * ⇒ availableTrips 可能为负。
 * 这里不截断，如实返回负数（展示层自行提示、提醒规则 TRIP_BALANCE_NEGATIVE 会喊），
 * 截断会掩盖账实不符。
 *
 * 这只是台账记录：不碰订单金额、不碰任何折扣字段、不进定价与结算路径。
 */
import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  RedemptionOrderMismatchError,
} from '../../lib/errors.js';
import { docKey } from './traveler-profiles.aggregate.js';
import { BENEFIT_AUTO_REVERSAL_ACTOR_ID } from './traveler-benefits.auto-reverse.js';
// 类型导入（`import type` 编译后完全擦除）⇒ 与 traveler-profiles.service 之间没有运行时循环依赖
import type { TravelerProfilesService } from './traveler-profiles.service.js';
import type { CreateRedemptionBody } from './travelers.schemas.js';

type RedemptionRow = Prisma.TravelerBenefitRedemptionGetPayload<Record<string, never>>;

/** 台账行 + 可选的订单号联查（loadRedemptions 带回；写入路径的返回值没有 order）。 */
type RedemptionRowWithOrder = RedemptionRow & { order?: { orderNumber: string } | null };

export interface RedemptionActor {
  userId: string;
}

// ── 可用次数口径（全站唯一实现）──────────────────────────────────────────────

export interface AvailableTripsInput {
  /** 合计已飞（新系统 + 老系统历史）。 */
  tripCount: number;
  /** 已付款在订未飞。 */
  pendingPaidTripCount: number;
  /** 已核销净额（sum(tripsUsed)，冲正后的净值）。 */
  redeemedTrips: number;
}

/**
 * 可用次数 = 已飞 + 已付款在订未飞 − 已核销（2026-09-21 拍板）。
 * 可为负，不截断 —— 负数就是账实不符的信号，交给提醒规则与展示层。
 */
export function computeAvailableTrips(input: AvailableTripsInput): number {
  return input.tripCount + input.pendingPaidTripCount - input.redeemedTrips;
}

/**
 * 核销可以挂的订单状态 = 「已付款且占座中」（与聚合里 countsAsPaidUpcoming 同一张表）。
 * 待支付单不许挂：那次行程还没进可用次数，挂上去等于提前把额度用掉。
 */
export const REDEEMABLE_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
  OrderStatus.CHANGE_REQUESTED,
  OrderStatus.CHANGED,
];

/** 台账条目对外形状（含操作人姓名快照、时间、挂的订单与「系统自动冲正」标记） */
export function serializeRedemption(row: RedemptionRowWithOrder) {
  return {
    id: row.id,
    profileId: row.profileId,
    tripsUsed: row.tripsUsed,
    benefit: row.benefit,
    note: row.note,
    reversalOfId: row.reversalOfId,
    orderId: row.orderId ?? null,
    orderNumber: row.order?.orderNumber ?? null,
    /** true = 订单取消 / 退款 / no-show 时系统自动追加的补偿行，不是人点的冲正。 */
    auto: row.createdById === BENEFIT_AUTO_REVERSAL_ACTOR_ID,
    createdById: row.createdById,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
  };
}

export type SerializedRedemption = ReturnType<typeof serializeRedemption>;

/**
 * 批量取「档案 id → 已核销净次数」（冲正后的净值）。
 * 一次 groupBy 覆盖整页，杜绝 N+1；没有流水的档案不在返回 Map 里（调用方按 0 处理）。
 */
export async function loadRedeemedTripsByProfile(
  profileIds: string[],
): Promise<Map<string, number>> {
  if (profileIds.length === 0) return new Map();
  const rows = await prisma.travelerBenefitRedemption.groupBy({
    by: ['profileId'],
    where: { profileId: { in: profileIds } },
    _sum: { tripsUsed: true },
  });
  return new Map(rows.map((r) => [r.profileId, r._sum.tripsUsed ?? 0]));
}

/** 单档案台账明细，按时间倒序（最新的核销/冲正在最前）；挂了单号的行联查单号。 */
export async function loadRedemptions(profileId: string): Promise<SerializedRedemption[]> {
  const rows = await prisma.travelerBenefitRedemption.findMany({
    where: { profileId },
    orderBy: { createdAt: 'desc' },
    include: { order: { select: { orderNumber: true } } },
  });
  return rows.map(serializeRedemption);
}

/** 给档案对象补上 redeemedTrips / availableTrips（列表/联想/详情统一口径与字段名） */
export function withBenefitTotals<
  T extends { id: string; tripCount: number; pendingPaidTripCount: number },
>(profile: T, redeemedByProfile: Map<string, number>): T & { redeemedTrips: number; availableTrips: number } {
  const redeemedTrips = redeemedByProfile.get(profile.id) ?? 0;
  return {
    ...profile,
    redeemedTrips,
    availableTrips: computeAvailableTrips({
      tripCount: profile.tripCount,
      pendingPaidTripCount: profile.pendingPaidTripCount,
      redeemedTrips,
    }),
  };
}

export class TravelerBenefitsService {
  constructor(private readonly profiles: TravelerProfilesService) {}

  /**
   * 核销：扣减可用次数，写一条正数流水。
   *
   * tripCount / pendingPaidTripCount 以订单与老系统历史次数为真值 —— 先走详情实时重算
   * （顺带把快照回写成最新值），事务内再从 TravelerProfile 重读一次快照并复核「已核销合计」后插入。
   * Serializable 隔离的保护范围：并发双扣（两个事务读到同一个 sum 各插一条 ⇒ 后提交的
   * 序列化冲突回滚），以及事务内读到的快照与流水的一致性。它防不住的是
   * 「订单侧变化尚未触发快照重算」——那属于快照机制本身的时效性，
   * 允许 availableTrips 为负、如实展示，正是给这类回落兜底的既定口径。
   *
   * 序列化冲突（P2034）是本设计**预期会发生**的分支：先自动重试一次（绝大多数并发
   * 都能在重试后正确判定），仍冲突则抛 409 给前端可读提示，绝不落进裸 500。
   *
   * 挂单号（body.orderId）在同一事务内校验：订单存在且未软删、状态属于已付款族、
   * 单上乘客证件命中本档案（主证 + 合并链上的旧证）；任一不满足 → 400 REDEMPTION_ORDER_MISMATCH。
   *
   * 传指针行 id（被合并的旧档案）会解析到主档案，流水永远挂在主档案上。
   */
  async redeem(profileId: string, body: CreateRedemptionBody, actor: RedemptionActor) {
    const detail = await this.profiles.getDetail(profileId);
    const masterId = detail.profile.id;
    const createdByName = await resolveActorName(actor.userId);
    const orderId = body.orderId?.trim() || null;
    // 挂单校验要用档案全部证件对（主证 + 并入的旧证）；不挂单就不查
    const docPairs = orderId ? await this.profiles.resolveDocPairs(masterId) : [];

    const runOnce = () =>
      prisma.$transaction(
        async (tx) => {
          // 事务内重读快照：getDetail 已把最新重算值回写，这里读回的就是它；
          // 事务外捕获的旧值不再参与判定，杜绝「重算与事务开始之间」的快照漂移窗口。
          const profileRow = await tx.travelerProfile.findUnique({
            where: { id: masterId },
            select: { tripCount: true, pendingPaidTripCount: true },
          });
          if (!profileRow) throw new NotFoundError('常旅客档案不存在');
          const liveTripCount = profileRow.tripCount;
          const livePendingPaid = profileRow.pendingPaidTripCount ?? 0;
          const agg = await tx.travelerBenefitRedemption.aggregate({
            where: { profileId: masterId },
            _sum: { tripsUsed: true },
          });
          const redeemedTrips = agg._sum.tripsUsed ?? 0;
          const availableTrips = computeAvailableTrips({
            tripCount: liveTripCount,
            pendingPaidTripCount: livePendingPaid,
            redeemedTrips,
          });
          if (body.tripsUsed > availableTrips) {
            throw new BadRequestError(
              `可核销次数不足：已飞 ${liveTripCount} 次，已付款在订未飞 ${livePendingPaid} 次，` +
                `已核销 ${redeemedTrips} 次，当前可用 ${availableTrips} 次`,
            );
          }
          if (orderId) await assertRedeemableOrder(tx, orderId, docPairs);
          return tx.travelerBenefitRedemption.create({
            data: {
              profileId: masterId,
              tripsUsed: body.tripsUsed,
              benefit: body.benefit,
              note: body.note ?? null,
              orderId,
              createdById: actor.userId,
              createdByName,
            },
            include: { order: { select: { orderNumber: true } } },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

    let created;
    try {
      created = await runOnce();
    } catch (err) {
      if (!isSerializationConflict(err)) throw err;
      try {
        created = await runOnce();
      } catch (retryErr) {
        if (!isSerializationConflict(retryErr)) throw retryErr;
        throw new ConflictError('有同事正在同时核销该档案，请刷新后重试');
      }
    }

    return {
      profileId: masterId,
      profileName: detail.profile.fullName,
      redemption: serializeRedemption(created),
    };
  }

  /**
   * 冲正：为写错的核销插一条负数补偿流水，原条目一个字都不动（挂的订单号照抄，好按单对账）。
   * 三道闸：原条目必须属于该档案、必须是核销（tripsUsed > 0）、必须没被冲正过
   * （最后一道由 reversalOfId 唯一约束在数据库层兜住并发）。
   */
  async reverse(
    profileId: string,
    redemptionId: string,
    note: string | null,
    actor: RedemptionActor,
  ) {
    const master = await this.profiles.resolveMaster(profileId);
    const createdByName = await resolveActorName(actor.userId);

    const original = await prisma.travelerBenefitRedemption.findUnique({
      where: { id: redemptionId },
    });
    // 不属于该档案时按「不存在」返回，避免拿别人档案的 id 探测台账
    if (!original || original.profileId !== master.id) throw new NotFoundError('核销记录不存在');
    if (original.tripsUsed <= 0) throw new BadRequestError('冲正条目不能再被冲正');
    const existing = await prisma.travelerBenefitRedemption.findUnique({
      where: { reversalOfId: redemptionId },
      select: { id: true },
    });
    if (existing) throw new ConflictError('该核销已冲正过，不能重复冲正');

    try {
      const created = await prisma.travelerBenefitRedemption.create({
        data: {
          profileId: master.id,
          tripsUsed: -original.tripsUsed,
          benefit: original.benefit,
          note,
          reversalOfId: original.id,
          orderId: original.orderId ?? null,
          createdById: actor.userId,
          createdByName,
        },
      });
      return {
        profileId: master.id,
        profileName: master.fullName,
        reversal: serializeRedemption(created),
        original: serializeRedemption(original),
      };
    } catch (err) {
      // 并发下两个冲正同时穿过上面的预检 ⇒ 唯一约束把后一个挡在数据库层
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictError('该核销已冲正过，不能重复冲正');
      }
      throw err;
    }
  }
}

/**
 * 挂单四道闸（任一不过 → 400 REDEMPTION_ORDER_MISMATCH，message 说清是哪一道）：
 *   1. 订单存在；2. 未进回收站；3. 状态属于已付款族；4. 单上乘客证件命中档案（主证或合并链旧证）。
 * 证件比对走 docKey（trim + 大写），与档案聚合同一口径。
 */
async function assertRedeemableOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  docPairs: ReadonlyArray<{ documentType: string; documentNumber: string }>,
): Promise<void> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      deletedAt: true,
      passengers: { select: { documentType: true, documentNumber: true } },
    },
  });
  if (!order) throw new RedemptionOrderMismatchError('挂单失败：找不到这张订单，请核对后重试');
  if (order.deletedAt) {
    throw new RedemptionOrderMismatchError(`挂单失败：订单 ${order.orderNumber} 在回收站，不能挂核销`);
  }
  if (!REDEEMABLE_ORDER_STATUSES.includes(order.status)) {
    throw new RedemptionOrderMismatchError(
      `挂单失败：订单 ${order.orderNumber} 当前状态不是已付款（待支付 / 已取消 / 已退款的单不能挂核销）`,
    );
  }
  const profileKeys = new Set(
    docPairs.map((d) => `${d.documentType}|${d.documentNumber.trim().toUpperCase()}`),
  );
  const hit = order.passengers.some((p) =>
    profileKeys.has(docKey(p.documentType, p.documentNumber)),
  );
  if (!hit) {
    throw new RedemptionOrderMismatchError(
      `挂单失败：订单 ${order.orderNumber} 的乘客里没有本档案的证件号（含合并前的旧证），请确认单号`,
    );
  }
}

/** Serializable 事务的写冲突（Prisma P2034）：并发核销互相判死时数据库抛出的预期错误。 */
function isSerializationConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';
}

/** 操作人姓名快照：displayName → email → 兜底角色词（账号后续改名/停用不影响台账可读性） */
async function resolveActorName(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { displayName: true, email: true },
  });
  return user?.displayName ?? user?.email ?? '内部账号';
}
