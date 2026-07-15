/**
 * 切位（包位）服务 — 从散客池划出 N 座给某代理专卖，到期未售回散客池。
 *
 * 散客池口径（与前台/后台余位一致，加上切位项）：
 *   散客池余票 = capacity − sold − ACTIVE 未过期锁位 − Σ(ACTIVE 切位 seats)
 *
 * 被切出的座位不是消失：代理仍可通过同一 FlightSeatClass.sold 扣减来卖，
 * 只是这批座位不再进散客池（不重复占用 —— 卖出时 sold++，切位 seats 仍占位，
 * 二者共同压缩散客池，但代理侧的销售走 sold，散客侧看 pool，互不超卖）。
 *
 * 说明（散客池 vs 公共 available）：
 *   flights.service 的 search() / listSchedules() 计算的 available = capacity − sold − locked，
 *   本模块不改动那处共享口径（跨模块、库存敏感、改动风险高）。本服务在【创建切位】时
 *   以 capacity − sold − locked − 已有 ACTIVE 切位 校验 seats，绝不超切；并对外暴露
 *   getPoolAvailability() / computePoolAvailability()，供切位 UI 或后续接入方按需读散客池真值。
 */
import {
  CabinClass,
  SeatAllocationStatus,
  SeatLockStatus,
} from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, NotFoundError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import type { AuditActor } from '../../lib/audit.js';
import type { CreateSeatAllocationBody, ListSeatAllocationsQuery } from './seat-allocation.schemas.js';

/**
 * 散客池余票（纯函数，全局唯一口径）：
 *   capacity − sold − 未过期锁位 − ACTIVE 切位
 * 负数夹到 0（对外展示口径；创建校验用未夹的原值更安全，见 createAllocation）。
 */
export function computePoolAvailability(input: {
  capacity: number;
  sold: number;
  locked: number;
  allocated: number;
}): number {
  return Math.max(0, input.capacity - input.sold - input.locked - input.allocated);
}

/**
 * 某条切位是否已过回收截止（纯函数）：出发时间 − reclaimDaysBefore 天 ≤ now。
 * 只对 ACTIVE 切位有意义；RECLAIMED 已回收，调用方自行过滤。
 */
export function isAllocationExpired(
  departureTime: Date,
  reclaimDaysBefore: number,
  now: Date = new Date(),
): boolean {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const cutoff = departureTime.getTime() - reclaimDaysBefore * MS_PER_DAY;
  return now.getTime() >= cutoff;
}

export class SeatAllocationService {
  /**
   * 读某舱位当前散客池余票（capacity − sold − 未过期锁位 − ACTIVE 切位）。
   * 可传 client 复用连接（默认全局 prisma）。
   */
  async getPoolAvailability(
    seatClassId: string,
    now: Date = new Date(),
  ): Promise<{
    seatClassId: string;
    scheduleId: string;
    cabin: CabinClass;
    capacity: number;
    sold: number;
    locked: number;
    allocated: number;
    poolAvailable: number;
  }> {
    const seatClass = await prisma.flightSeatClass.findUnique({
      where: { id: seatClassId },
      select: { id: true, scheduleId: true, cabin: true, capacity: true, sold: true },
    });
    if (!seatClass) throw new NotFoundError('舱位不存在');

    const lockAgg = await prisma.seatLock.aggregate({
      _sum: { qty: true },
      where: { seatClassId, status: SeatLockStatus.ACTIVE, expiresAt: { gt: now } },
    });
    const allocAgg = await prisma.seatAllocation.aggregate({
      _sum: { seats: true },
      where: {
        flightScheduleId: seatClass.scheduleId,
        cabin: seatClass.cabin,
        status: SeatAllocationStatus.ACTIVE,
      },
    });
    const locked = lockAgg._sum.qty ?? 0;
    const allocated = allocAgg._sum.seats ?? 0;
    return {
      seatClassId: seatClass.id,
      scheduleId: seatClass.scheduleId,
      cabin: seatClass.cabin,
      capacity: seatClass.capacity,
      sold: seatClass.sold,
      locked,
      allocated,
      poolAvailable: computePoolAvailability({
        capacity: seatClass.capacity,
        sold: seatClass.sold,
        locked,
        allocated,
      }),
    };
  }

  /**
   * 创建切位。校验：班次存在、该舱位在班次上存在、agent 存在、seats ≤ 当前散客池余票。
   * 并发安全：事务内对 FlightSeatClass 行 FOR UPDATE 加锁，串行化同一舱位的并发切位/锁位，
   * 防止两个请求同时通过余量检查造成超切（同 seat-locks 扣座思路）。
   */
  async createAllocation(body: CreateSeatAllocationBody, actor?: AuditActor) {
    const now = new Date();

    const allocation = await prisma.$transaction(async (tx) => {
      // 行锁：定位 scheduleId+cabin 的舱位并锁行（散客池的容量真值来源）
      const rows = await tx.$queryRaw<
        Array<{ id: string; scheduleId: string; capacity: number; sold: number }>
      >`
        SELECT sc.id, sc."scheduleId", sc.capacity, sc.sold
        FROM "FlightSeatClass" sc
        WHERE sc."scheduleId" = ${body.flightScheduleId} AND sc.cabin = ${body.cabin}::"CabinClass"
        FOR UPDATE
      `;
      const seatClass = rows[0];
      if (!seatClass) {
        // 班次不存在 or 该班次没有此舱位 —— 分别给更贴切的提示
        const schedule = await tx.flightSchedule.findUnique({
          where: { id: body.flightScheduleId },
          select: { id: true },
        });
        if (!schedule) throw new NotFoundError('班次不存在');
        throw new BadRequestError('该班次没有此舱位');
      }

      const agent = await tx.agent.findUnique({
        where: { id: body.agentId },
        select: { id: true, isActive: true },
      });
      if (!agent) throw new NotFoundError('代理不存在');

      // 散客池余量：capacity − sold − 未过期锁位 − 已有 ACTIVE 切位（本事务连接内读，含刚锁的行）
      const lockAgg = await tx.seatLock.aggregate({
        _sum: { qty: true },
        where: { seatClassId: seatClass.id, status: SeatLockStatus.ACTIVE, expiresAt: { gt: now } },
      });
      const allocAgg = await tx.seatAllocation.aggregate({
        _sum: { seats: true },
        where: {
          flightScheduleId: body.flightScheduleId,
          cabin: body.cabin,
          status: SeatAllocationStatus.ACTIVE,
        },
      });
      const locked = lockAgg._sum.qty ?? 0;
      const allocated = allocAgg._sum.seats ?? 0;
      const pool = seatClass.capacity - seatClass.sold - locked - allocated;
      if (body.seats > pool) {
        throw new BadRequestError(
          `可切位余量不足：需切 ${body.seats} 座，散客池仅剩 ${Math.max(0, pool)} 座`,
        );
      }

      return tx.seatAllocation.create({
        data: {
          flightScheduleId: body.flightScheduleId,
          cabin: body.cabin,
          agentId: body.agentId,
          seats: body.seats,
          unitPriceCny: body.unitPriceCny ?? null,
          ...(body.reclaimDaysBefore !== undefined && { reclaimDaysBefore: body.reclaimDaysBefore }),
          notes: body.notes ?? null,
          status: SeatAllocationStatus.ACTIVE,
        },
      });
    });

    void writeAudit({
      actor: actor ?? {},
      action: 'CREATE_SEAT_ALLOCATION',
      targetType: 'FLIGHT',
      targetId: allocation.flightScheduleId,
      targetLabel: `切位 ${allocation.seats} 座（${allocation.cabin}）→ 代理 ${allocation.agentId}`,
      after: {
        allocationId: allocation.id,
        cabin: allocation.cabin,
        seats: allocation.seats,
        agentId: allocation.agentId,
      },
      severity: 'WARNING',
    });

    return allocation;
  }

  /**
   * 列表：按 flightScheduleId / agentId 过滤（都选填），带代理 + 班次信息。
   * 默认返回 ACTIVE + RECLAIMED（切位 UI 要能看到历史回收记录）。
   */
  async listAllocations(query: ListSeatAllocationsQuery) {
    const allocations = await prisma.seatAllocation.findMany({
      where: {
        ...(query.flightScheduleId ? { flightScheduleId: query.flightScheduleId } : {}),
        ...(query.agentId ? { agentId: query.agentId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        agent: {
          select: { id: true, companyName: true, contactName: true, tier: true },
        },
        flightSchedule: {
          select: {
            id: true,
            departureTime: true,
            departureTz: true,
            flight: { select: { flightNumber: true, originCode: true, destinationCode: true } },
          },
        },
      },
    });

    const now = new Date();
    return allocations.map((a) => ({
      id: a.id,
      flightScheduleId: a.flightScheduleId,
      cabin: a.cabin,
      agentId: a.agentId,
      agent: a.agent,
      seats: a.seats,
      unitPriceCny: a.unitPriceCny,
      reclaimDaysBefore: a.reclaimDaysBefore,
      status: a.status,
      notes: a.notes,
      flightNumber: a.flightSchedule.flight.flightNumber,
      originCode: a.flightSchedule.flight.originCode,
      destinationCode: a.flightSchedule.flight.destinationCode,
      departureTime: a.flightSchedule.departureTime.toISOString(),
      departureTz: a.flightSchedule.departureTz,
      // 是否已过回收截止（仅 ACTIVE 有意义；供 UI 高亮「可回收」）
      expired:
        a.status === SeatAllocationStatus.ACTIVE &&
        isAllocationExpired(a.flightSchedule.departureTime, a.reclaimDaysBefore, now),
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    }));
  }

  /**
   * 回收一条切位：ACTIVE → RECLAIMED（座位回散客池）。
   * 原子 CAS：只在 ACTIVE 时回收，已回收再点无副作用（幂等报错）。
   */
  async reclaimAllocation(id: string, actor?: AuditActor) {
    const existing = await prisma.seatAllocation.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('切位不存在');

    const upd = await prisma.seatAllocation.updateMany({
      where: { id, status: SeatAllocationStatus.ACTIVE },
      data: { status: SeatAllocationStatus.RECLAIMED },
    });
    if (upd.count === 0) {
      throw new BadRequestError(`切位当前状态不可回收（${existing.status}）`);
    }

    void writeAudit({
      actor: actor ?? {},
      action: 'RECLAIM_SEAT_ALLOCATION',
      targetType: 'FLIGHT',
      targetId: existing.flightScheduleId,
      targetLabel: `回收切位 ${existing.seats} 座（${existing.cabin}）← 代理 ${existing.agentId}`,
      before: { status: existing.status },
      after: { status: SeatAllocationStatus.RECLAIMED },
      severity: 'WARNING',
    });

    return { id, status: SeatAllocationStatus.RECLAIMED };
  }

  /**
   * 自动回收助手：把所有「已过回收截止」的 ACTIVE 切位标 RECLAIMED。
   * 供后续定时任务（cron）调用；本 PR 不接 cron，仅暴露方法与纯函数 isAllocationExpired。
   * 返回被回收的切位 id 列表（幂等：无到期项返回空数组）。
   */
  async autoReclaimExpired(now: Date = new Date()): Promise<string[]> {
    const actives = await prisma.seatAllocation.findMany({
      where: { status: SeatAllocationStatus.ACTIVE },
      select: {
        id: true,
        reclaimDaysBefore: true,
        flightSchedule: { select: { departureTime: true } },
      },
    });
    const expiredIds = actives
      .filter((a) => isAllocationExpired(a.flightSchedule.departureTime, a.reclaimDaysBefore, now))
      .map((a) => a.id);
    if (expiredIds.length === 0) return [];

    await prisma.seatAllocation.updateMany({
      where: { id: { in: expiredIds }, status: SeatAllocationStatus.ACTIVE },
      data: { status: SeatAllocationStatus.RECLAIMED },
    });
    return expiredIds;
  }
}
