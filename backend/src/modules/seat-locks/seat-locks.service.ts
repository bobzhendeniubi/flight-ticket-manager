/**
 * 锁位服务 — 下单前临时占座，到期自动回归可售。
 *
 * 业务规则（客户确认）：
 *   1. 单个用户在同一舱位的 ACTIVE 锁位总量 ≤ 9 张（含本次）
 *   2. 固定 10 分钟有效；到期 BullMQ worker 标 EXPIRED
 *   3. 下单时消费本人锁位（orders.service.createOrder 标 CONSUMED）
 *
 * 可用量口径：capacity - sold - SUM(ACTIVE 且 expiresAt > now 的锁位 qty)。
 * 所有查询都按 status=ACTIVE AND expiresAt > now 惰性过滤，
 * 正确性不依赖 worker 准时执行（worker 只负责把状态落库）。
 */
import { SeatLockStatus, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import type { CreateSeatLockBody } from './seat-locks.schemas.js';

// 单用户同舱位 ACTIVE 锁位总量上限（含本次锁的张数）
const MAX_ACTIVE_LOCK_QTY_PER_USER = 9;
// 锁位固定有效期：10 分钟
const SEAT_LOCK_TTL_MS = 10 * 60 * 1000;

export interface SeatLockRequester {
  userId: string;
  role: UserRole;
}

export class SeatLockService {
  // ════════════════════════════════════════════════════════════════════
  // 创建锁位
  // ════════════════════════════════════════════════════════════════════
  async createLock(body: CreateSeatLockBody, userId: string) {
    const now = new Date();

    const lock = await prisma.$transaction(async (tx) => {
      // 行锁串行化同一舱位的并发锁位请求 —— 防止两个请求同时通过余量检查
      // （同 orders.service 扣座的原子 CAS 思路；这里需要读 capacity/sold 所以用 FOR UPDATE）
      const rows = await tx.$queryRaw<
        Array<{ id: string; scheduleId: string; capacity: number; sold: number }>
      >`
        SELECT id, "scheduleId", capacity, sold
        FROM "FlightSeatClass"
        WHERE id = ${body.seatClassId}
        FOR UPDATE
      `;
      const seatClass = rows[0];
      if (!seatClass || seatClass.scheduleId !== body.flightScheduleId) {
        throw new NotFoundError('舱位不存在');
      }

      // 单用户限额：同舱位 ACTIVE 未过期锁位 + 本次 ≤ 9
      const mine = await tx.seatLock.aggregate({
        _sum: { qty: true },
        where: {
          seatClassId: body.seatClassId,
          userId,
          status: SeatLockStatus.ACTIVE,
          expiresAt: { gt: now },
        },
      });
      const myActiveQty = mine._sum.qty ?? 0;
      if (myActiveQty + body.qty > MAX_ACTIVE_LOCK_QTY_PER_USER) {
        throw new ConflictError(
          `同一舱位最多锁 ${MAX_ACTIVE_LOCK_QTY_PER_USER} 张：已锁 ${myActiveQty} 张，本次 ${body.qty} 张超限`,
        );
      }

      // 余量检查：capacity - sold - 全部 ACTIVE 未过期锁位 ≥ qty
      const all = await tx.seatLock.aggregate({
        _sum: { qty: true },
        where: {
          seatClassId: body.seatClassId,
          status: SeatLockStatus.ACTIVE,
          expiresAt: { gt: now },
        },
      });
      const lockedQty = all._sum.qty ?? 0;
      const available = seatClass.capacity - seatClass.sold - lockedQty;
      if (available < body.qty) {
        throw new ConflictError(
          `余票不足：需要锁 ${body.qty} 张，仅剩 ${Math.max(0, available)} 张可锁`,
        );
      }

      return tx.seatLock.create({
        data: {
          flightScheduleId: body.flightScheduleId,
          seatClassId: body.seatClassId,
          userId,
          qty: body.qty,
          status: SeatLockStatus.ACTIVE,
          expiresAt: new Date(now.getTime() + SEAT_LOCK_TTL_MS),
        },
      });
    });

    // 事务成功后排队到期任务（排队失败不阻塞 —— 查询侧 expiresAt 惰性过滤兜底）
    const delayMs = Math.max(0, lock.expiresAt.getTime() - Date.now());
    try {
      const { scheduleSeatLockExpiry } = await import('../../queues/queue.js');
      await scheduleSeatLockExpiry(lock.id, delayMs);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[seat-locks] failed to schedule expiry for', lock.id, err);
    }

    return lock;
  }

  // ════════════════════════════════════════════════════════════════════
  // 我的锁位（ACTIVE 且未过期）
  // ════════════════════════════════════════════════════════════════════
  async listMyLocks(userId: string) {
    const locks = await prisma.seatLock.findMany({
      where: { userId, status: SeatLockStatus.ACTIVE, expiresAt: { gt: new Date() } },
      include: {
        flightSchedule: {
          // departureTz：前台要按出发地当地时区显示起飞时刻（不带就只能按浏览器时区猜）
          select: { departureTime: true, departureTz: true, flight: { select: { flightNumber: true } } },
        },
        seatClass: { select: { cabin: true } },
      },
      orderBy: { expiresAt: 'asc' },
    });

    return locks.map((l) => ({
      id: l.id,
      flightScheduleId: l.flightScheduleId,
      seatClassId: l.seatClassId,
      flightNumber: l.flightSchedule.flight.flightNumber,
      departureTime: l.flightSchedule.departureTime.toISOString(),
      departureTz: l.flightSchedule.departureTz,
      cabin: l.seatClass.cabin,
      qty: l.qty,
      expiresAt: l.expiresAt.toISOString(),
      createdAt: l.createdAt.toISOString(),
    }));
  }

  // ════════════════════════════════════════════════════════════════════
  // 释放锁位（本人或 ADMIN/STAFF）
  // ════════════════════════════════════════════════════════════════════
  async releaseLock(id: string, requester: SeatLockRequester) {
    const lock = await prisma.seatLock.findUnique({ where: { id } });
    if (!lock) throw new NotFoundError('锁位不存在');

    const isOwner = lock.userId === requester.userId;
    const isOps = requester.role === UserRole.ADMIN || requester.role === UserRole.STAFF;
    if (!isOwner && !isOps) throw new ForbiddenError('只能释放自己的锁位');

    // 原子 CAS：只在仍 ACTIVE 时释放（已消费/已过期/已释放不可重复操作）
    const upd = await prisma.seatLock.updateMany({
      where: { id, status: SeatLockStatus.ACTIVE },
      data: { status: SeatLockStatus.RELEASED },
    });
    if (upd.count === 0) {
      throw new ConflictError(`锁位当前状态不可释放（${lock.status}）`);
    }

    // 移除待执行的到期任务（best-effort；worker 端幂等，残留任务无副作用）
    try {
      const { cancelSeatLockExpiry } = await import('../../queues/queue.js');
      await cancelSeatLockExpiry(id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[seat-locks] failed to cancel expiry job for', id, err);
    }

    return { id, status: SeatLockStatus.RELEASED };
  }
}
