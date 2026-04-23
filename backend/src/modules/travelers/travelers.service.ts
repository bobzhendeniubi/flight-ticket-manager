/**
 * 旅客（SavedPassenger）服务（ADMIN/STAFF 管理端）
 *
 * tripCount / lastTripAt 从 Passenger 表按 fullName + DOB 匹配推算。
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import type { CreateTravelerBody, ListTravelersQuery, UpdateTravelerBody } from './travelers.schemas.js';

export class TravelersService {
  async list(query: ListTravelersQuery & { agentTreeIds?: string[] }) {
    const where: Prisma.SavedPassengerWhereInput = {};
    if (query.userId) where.userId = query.userId;
    if (query.search) {
      where.OR = [
        { fullName: { contains: query.search, mode: 'insensitive' } },
        { documentNumber: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.dob) where.dateOfBirth = new Date(`${query.dob}T00:00:00Z`);
    // AGENT 作用域：旅客的 user.customerProfile.primaryAgentId ∈ 自己树
    if (query.agentTreeIds) {
      where.user = {
        customerProfile: { is: { primaryAgentId: { in: query.agentTreeIds } } },
      };
    }

    const [rows, total] = await prisma.$transaction([
      prisma.savedPassenger.findMany({
        where,
        include: {
          user: { select: { id: true, displayName: true, email: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: query.pageSize,
        skip: (query.page - 1) * query.pageSize,
      }),
      prisma.savedPassenger.count({ where }),
    ]);

    // 批量算 tripCount / lastTripAt（通过 Passenger 表按 fullName+DOB 匹配）
    const tripMap = await this.aggregateTrips(rows.map((r) => ({ fullName: r.fullName, dob: r.dateOfBirth })));

    return {
      travelers: rows.map((r) => {
        const key = tripKey(r.fullName, r.dateOfBirth);
        const trips = tripMap.get(key) ?? { count: 0, lastAt: null };
        return {
          id: r.id,
          userId: r.userId,
          customer: r.user,
          fullName: r.fullName,
          documentType: r.documentType,
          documentNumber: r.documentNumber,
          dateOfBirth: r.dateOfBirth,
          nationality: r.nationality,
          passengerType: r.passengerType,
          phone: r.phone,
          notes: r.notes,
          tripCount: trips.count,
          lastTripAt: trips.lastAt,
          createdAt: r.createdAt,
        };
      }),
      pagination: { page: query.page, pageSize: query.pageSize, total },
    };
  }

  async getById(id: string) {
    const r = await prisma.savedPassenger.findUnique({
      where: { id },
      include: { user: { select: { id: true, displayName: true, email: true, phone: true } } },
    });
    if (!r) throw new NotFoundError('旅客不存在');

    // 匹配 Passenger 表找历史订单
    const passengers = await prisma.passenger.findMany({
      where: { fullName: r.fullName, dateOfBirth: r.dateOfBirth },
      include: { order: { select: { id: true, orderNumber: true, status: true, total: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return {
      id: r.id,
      userId: r.userId,
      customer: r.user,
      fullName: r.fullName,
      documentType: r.documentType,
      documentNumber: r.documentNumber,
      dateOfBirth: r.dateOfBirth,
      nationality: r.nationality,
      passengerType: r.passengerType,
      phone: r.phone,
      notes: r.notes,
      tripCount: passengers.length,
      lastTripAt: passengers[0]?.order.createdAt ?? null,
      trips: passengers.map((p) => ({
        id: p.id,
        order: {
          id: p.order.id,
          orderNumber: p.order.orderNumber,
          status: p.order.status,
          total: p.order.total.toString(),
          createdAt: p.order.createdAt,
        },
        pnr: p.pnr,
        eticketNumber: p.eticketNumber,
      })),
    };
  }

  async create(body: CreateTravelerBody) {
    const user = await prisma.user.findUnique({ where: { id: body.userId } });
    if (!user) throw new NotFoundError('关联用户不存在');

    const r = await prisma.savedPassenger.create({
      data: {
        userId: body.userId,
        fullName: body.fullName,
        documentType: body.documentType,
        documentNumber: body.documentNumber,
        dateOfBirth: new Date(body.dateOfBirth),
        nationality: body.nationality,
        passengerType: body.passengerType,
        phone: body.phone,
        notes: body.notes,
      },
    });
    return r;
  }

  async update(id: string, body: UpdateTravelerBody) {
    const existing = await prisma.savedPassenger.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('旅客不存在');

    const data: Prisma.SavedPassengerUpdateInput = {};
    if (body.fullName !== undefined) data.fullName = body.fullName;
    if (body.documentType !== undefined) data.documentType = body.documentType;
    if (body.documentNumber !== undefined) data.documentNumber = body.documentNumber;
    if (body.dateOfBirth !== undefined) data.dateOfBirth = new Date(body.dateOfBirth);
    if (body.nationality !== undefined) data.nationality = body.nationality;
    if (body.passengerType !== undefined) data.passengerType = body.passengerType;
    if (body.phone !== undefined) data.phone = body.phone;
    if (body.notes !== undefined) data.notes = body.notes;

    return prisma.savedPassenger.update({ where: { id }, data });
  }

  async delete(id: string) {
    const existing = await prisma.savedPassenger.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('旅客不存在');
    await prisma.savedPassenger.delete({ where: { id } });
    return { id };
  }

  // ── private helpers ──
  private async aggregateTrips(pairs: Array<{ fullName: string; dob: Date }>) {
    if (pairs.length === 0) return new Map<string, { count: number; lastAt: Date | null }>();
    // 简化：逐条分组查，pairs 通常 <= pageSize（100）
    const map = new Map<string, { count: number; lastAt: Date | null }>();
    await Promise.all(
      pairs.map(async (p) => {
        const agg = await prisma.passenger.aggregate({
          where: { fullName: p.fullName, dateOfBirth: p.dob },
          _count: { _all: true },
          _max: { createdAt: true },
        });
        map.set(tripKey(p.fullName, p.dob), {
          count: agg._count._all,
          lastAt: agg._max.createdAt ?? null,
        });
      }),
    );
    return map;
  }
}

function tripKey(name: string, dob: Date): string {
  return `${name}|${dob.toISOString().slice(0, 10)}`;
}
