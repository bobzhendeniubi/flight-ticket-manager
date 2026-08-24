/**
 * 候补服务 — 舱位售罄/余票不足时登记候补，座位释放后按先来先到通知。
 *
 * 业务规则：
 *   1. 仅余票不足（available < qty）时允许登记 —— 有票应直接下单，不收候补
 *   2. 同一用户同一舱位只允许一条 ACTIVE 候补（重复登记 409）
 *   3. 座位释放（订单取消/超时、锁位过期）时 notification worker 检查
 *      最早的 ACTIVE 候补，余量够则 CAS 标 NOTIFIED（短信通知后续接入）
 *
 * 可用量口径与锁位一致：capacity - sold - SUM(ACTIVE 且未过期锁位 qty)。
 */
import { SeatLockStatus, UserRole, WaitlistStatus } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import type { CreateWaitlistBody } from './waitlist.schemas.js';

export interface WaitlistRequester {
  userId: string;
  role: UserRole;
}

export class WaitlistService {
  // ════════════════════════════════════════════════════════════════════
  // 登记候补
  // ════════════════════════════════════════════════════════════════════
  async createEntry(body: CreateWaitlistBody, userId: string) {
    const now = new Date();

    const seatClass = await prisma.flightSeatClass.findUnique({
      where: { id: body.seatClassId },
      select: { id: true, scheduleId: true, capacity: true, sold: true },
    });
    if (!seatClass || seatClass.scheduleId !== body.flightScheduleId) {
      throw new NotFoundError('舱位不存在');
    }

    // 一人一舱位一条 ACTIVE 候补
    const existing = await prisma.seatWaitlist.findFirst({
      where: { seatClassId: body.seatClassId, userId, status: WaitlistStatus.ACTIVE },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictError('您已在该舱位的候补名单中，请勿重复登记');
    }

    // 仅余票不足时可候补：余量够（available ≥ qty）应直接下单
    const locked = await prisma.seatLock.aggregate({
      _sum: { qty: true },
      where: {
        seatClassId: body.seatClassId,
        status: SeatLockStatus.ACTIVE,
        expiresAt: { gt: now },
      },
    });
    const available = seatClass.capacity - seatClass.sold - (locked._sum.qty ?? 0);
    if (available >= body.qty) {
      throw new BadRequestError('该舱位当前余票充足，可直接下单，无需候补');
    }

    return prisma.seatWaitlist.create({
      data: {
        flightScheduleId: body.flightScheduleId,
        seatClassId: body.seatClassId,
        userId,
        qty: body.qty,
        contactPhone: body.contactPhone,
        status: WaitlistStatus.ACTIVE,
      },
    });
  }

  // ════════════════════════════════════════════════════════════════════
  // 我的候补（ACTIVE / NOTIFIED — 仍在跟进中的）
  // ════════════════════════════════════════════════════════════════════
  async listMyEntries(userId: string) {
    const entries = await prisma.seatWaitlist.findMany({
      where: { userId, status: { in: [WaitlistStatus.ACTIVE, WaitlistStatus.NOTIFIED] } },
      include: {
        flightSchedule: {
          // departureTz：前台要按出发地当地时区显示起飞时刻（不带就只能按浏览器时区猜）
          select: { departureTime: true, departureTz: true, flight: { select: { flightNumber: true } } },
        },
        seatClass: { select: { cabin: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return entries.map((e) => ({
      id: e.id,
      flightScheduleId: e.flightScheduleId,
      seatClassId: e.seatClassId,
      flightNumber: e.flightSchedule.flight.flightNumber,
      departureTime: e.flightSchedule.departureTime.toISOString(),
      departureTz: e.flightSchedule.departureTz,
      cabin: e.seatClass.cabin,
      qty: e.qty,
      status: e.status,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  // ════════════════════════════════════════════════════════════════════
  // 取消候补（本人或 ADMIN/STAFF）
  // ════════════════════════════════════════════════════════════════════
  async cancelEntry(id: string, requester: WaitlistRequester) {
    const entry = await prisma.seatWaitlist.findUnique({ where: { id } });
    if (!entry) throw new NotFoundError('候补记录不存在');

    const isOwner = entry.userId === requester.userId;
    const isOps = requester.role === UserRole.ADMIN || requester.role === UserRole.STAFF;
    if (!isOwner && !isOps) throw new ForbiddenError('只能取消自己的候补');

    // 原子 CAS：只在仍 ACTIVE/NOTIFIED 时取消（已成交/已取消不可重复操作）
    const upd = await prisma.seatWaitlist.updateMany({
      where: { id, status: { in: [WaitlistStatus.ACTIVE, WaitlistStatus.NOTIFIED] } },
      data: { status: WaitlistStatus.CANCELLED },
    });
    if (upd.count === 0) {
      throw new ConflictError(`候补当前状态不可取消（${entry.status}）`);
    }

    return { id, status: WaitlistStatus.CANCELLED };
  }

  // ════════════════════════════════════════════════════════════════════
  // 运营：某班次的候补名单（含用户联系方式，方便电话回访）
  // ════════════════════════════════════════════════════════════════════
  async listBySchedule(scheduleId: string) {
    const entries = await prisma.seatWaitlist.findMany({
      where: { flightScheduleId: scheduleId },
      include: {
        user: { select: { id: true, displayName: true, email: true, phone: true } },
        seatClass: { select: { cabin: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return entries.map((e) => ({
      id: e.id,
      seatClassId: e.seatClassId,
      cabin: e.seatClass.cabin,
      qty: e.qty,
      status: e.status,
      contactPhone: e.contactPhone,
      user: e.user,
      createdAt: e.createdAt.toISOString(),
    }));
  }
}
