/**
 * 常旅客权益核销台账 —— append-only 流水，永不删改。
 *
 * 口径：
 *   可用次数 availableTrips = 已飞 tripCount − 本档案流水 sum(tripsUsed)
 *   核销 tripsUsed > 0（扣减可用次数）；录错走冲正（compensating entry）：
 *   插入一条 tripsUsed = −原值、reversalOfId 指向原条目的补偿流水，原条目原样留存。
 *   reversalOfId 唯一约束 ⇒ 一条核销最多冲正一次（并发下由数据库兜底）。
 *
 * tripCount 是「订单重算出来的快照」，退订/删单会让它掉下去 ⇒ availableTrips 可能为负。
 * 这里不截断，如实返回负数（展示层自行提示），截断会掩盖账实不符。
 *
 * 这只是台账记录：不碰订单金额、不碰任何折扣字段、不进定价与结算路径。
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';
// 类型导入（`import type` 编译后完全擦除）⇒ 与 traveler-profiles.service 之间没有运行时循环依赖
import type { TravelerProfilesService } from './traveler-profiles.service.js';
import type { CreateRedemptionBody } from './travelers.schemas.js';

type RedemptionRow = Prisma.TravelerBenefitRedemptionGetPayload<Record<string, never>>;

export interface RedemptionActor {
  userId: string;
}

/** 台账条目对外形状（含操作人姓名快照与时间） */
export function serializeRedemption(row: RedemptionRow) {
  return {
    id: row.id,
    profileId: row.profileId,
    tripsUsed: row.tripsUsed,
    benefit: row.benefit,
    note: row.note,
    reversalOfId: row.reversalOfId,
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

/** 单档案台账明细，按时间倒序（最新的核销/冲正在最前） */
export async function loadRedemptions(profileId: string): Promise<SerializedRedemption[]> {
  const rows = await prisma.travelerBenefitRedemption.findMany({
    where: { profileId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(serializeRedemption);
}

/** 给档案对象补上 redeemedTrips / availableTrips（列表/联想/详情统一口径与字段名） */
export function withBenefitTotals<T extends { id: string; tripCount: number }>(
  profile: T,
  redeemedByProfile: Map<string, number>,
): T & { redeemedTrips: number; availableTrips: number } {
  const redeemedTrips = redeemedByProfile.get(profile.id) ?? 0;
  return { ...profile, redeemedTrips, availableTrips: profile.tripCount - redeemedTrips };
}

export class TravelerBenefitsService {
  constructor(private readonly profiles: TravelerProfilesService) {}

  /**
   * 核销：扣减可用次数，写一条正数流水。
   *
   * tripCount 以订单为真值 —— 先走详情实时重算（顺带把快照回写成最新值），
   * 再在事务内复核「已核销合计」并插入；Serializable 隔离让并发双扣被数据库判死
   * （两个并发事务读到同一个 sum 各插一条 ⇒ 后提交的那个序列化冲突回滚）。
   *
   * 传指针行 id（被合并的旧档案）会解析到主档案，流水永远挂在主档案上。
   */
  async redeem(profileId: string, body: CreateRedemptionBody, actor: RedemptionActor) {
    const detail = await this.profiles.getDetail(profileId);
    const masterId = detail.profile.id;
    const liveTripCount = detail.profile.tripCount;
    const createdByName = await resolveActorName(actor.userId);

    const created = await prisma.$transaction(
      async (tx) => {
        const agg = await tx.travelerBenefitRedemption.aggregate({
          where: { profileId: masterId },
          _sum: { tripsUsed: true },
        });
        const redeemedTrips = agg._sum.tripsUsed ?? 0;
        const availableTrips = liveTripCount - redeemedTrips;
        if (body.tripsUsed > availableTrips) {
          throw new BadRequestError(
            `可核销次数不足：已飞 ${liveTripCount} 次，已核销 ${redeemedTrips} 次，当前可用 ${availableTrips} 次`,
          );
        }
        return tx.travelerBenefitRedemption.create({
          data: {
            profileId: masterId,
            tripsUsed: body.tripsUsed,
            benefit: body.benefit,
            note: body.note ?? null,
            createdById: actor.userId,
            createdByName,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return {
      profileId: masterId,
      profileName: detail.profile.fullName,
      redemption: serializeRedemption(created),
    };
  }

  /**
   * 冲正：为写错的核销插一条负数补偿流水，原条目一个字都不动。
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

/** 操作人姓名快照：displayName → email → 兜底角色词（账号后续改名/停用不影响台账可读性） */
async function resolveActorName(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { displayName: true, email: true },
  });
  return user?.displayName ?? user?.email ?? '内部账号';
}
