/**
 * 客户服务（ADMIN/STAFF）
 *
 * 客户 = User(role=CUSTOMER) + CustomerProfile（扩展画像）。
 * 聚合 totalOrders / totalSpent / lastOrderAt 从 Order 表实时算。
 */
import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, NotFoundError } from '../../lib/errors.js';
import type { ListCustomersQuery, UpdateCustomerBody } from './customers.schemas.js';

const PAID_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.TICKETED,
  OrderStatus.COMPLETED,
];

export class CustomersService {
  /**
   * query.agentTreeIds —— AGENT 调用时传入自己 + 后代 agent 的 id 集合；
   * 服务强制按 primaryAgentId IN (tree) 过滤，防止代理看到不属于自己树的客户。
   */
  async list(query: ListCustomersQuery & { agentTreeIds?: string[] }) {
    const where: Prisma.UserWhereInput = { role: 'CUSTOMER' };
    if (query.search) {
      where.OR = [
        { displayName: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search } },
      ];
    }
    const profileFilter: Prisma.CustomerProfileWhereInput = {};
    if (query.agentId) profileFilter.primaryAgentId = query.agentId;
    if (query.tag) profileFilter.tags = { has: query.tag };
    // AGENT 强制作用域：只看自己树里的客户
    if (query.agentTreeIds) {
      profileFilter.primaryAgentId = { in: query.agentTreeIds };
    }
    if (query.agentId || query.tag || query.agentTreeIds) {
      where.customerProfile = { is: profileFilter };
    }

    const [users, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        include: {
          customerProfile: { include: { primaryAgent: { select: { id: true, companyName: true, contactName: true, tier: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: query.pageSize,
        skip: (query.page - 1) * query.pageSize,
      }),
      prisma.user.count({ where }),
    ]);

    // 批量查订单聚合
    const userIds = users.map((u) => u.id);
    const aggMap = new Map<string, { orders: number; spent: number; lastAt: Date | null }>();
    if (userIds.length > 0) {
      const rows = await prisma.order.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, status: { in: PAID_STATUSES } },
        _count: { _all: true },
        _sum: { total: true },
        _max: { createdAt: true },
      });
      rows.forEach((r) =>
        aggMap.set(r.userId, {
          orders: r._count?._all ?? 0,
          spent: Number(r._sum?.total ?? 0),
          lastAt: r._max?.createdAt ?? null,
        }),
      );
    }

    return {
      customers: users.map((u) => serializeCustomer(u, aggMap.get(u.id))),
      pagination: { page: query.page, pageSize: query.pageSize, total },
    };
  }

  /** agentTreeIds 传入 → AGENT 只能看自己树里的客户，否则 404（保护 id 不暴露） */
  async getById(id: string, agentTreeIds?: string[]) {
    const u = await prisma.user.findUnique({
      where: { id },
      include: {
        customerProfile: { include: { primaryAgent: { select: { id: true, companyName: true, contactName: true, tier: true } } } },
      },
    });
    if (!u || u.role !== 'CUSTOMER') throw new NotFoundError('客户不存在');
    if (agentTreeIds) {
      const pid = u.customerProfile?.primaryAgentId;
      if (!pid || !agentTreeIds.includes(pid)) throw new NotFoundError('客户不存在');
    }

    const agg = await prisma.order.aggregate({
      where: { userId: id, status: { in: PAID_STATUSES } },
      _count: { _all: true },
      _sum: { total: true },
      _max: { createdAt: true },
    });

    // 顺便返回最近 5 笔订单
    const recentOrders = await prisma.order.findMany({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { items: { select: { description: true, kind: true } } },
    });

    // 旅客档案
    const travelers = await prisma.savedPassenger.findMany({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
    });

    return {
      ...serializeCustomer(u, {
        orders: agg._count?._all ?? 0,
        spent: Number(agg._sum?.total ?? 0),
        lastAt: agg._max?.createdAt ?? null,
      }),
      recentOrders: recentOrders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        total: o.total.toString(),
        createdAt: o.createdAt,
        summary: o.items.map((it) => it.description).join(' + '),
      })),
      travelers: travelers.map((t) => ({
        id: t.id,
        fullName: t.fullName,
        documentNumber: t.documentNumber,
        dateOfBirth: t.dateOfBirth,
        nationality: t.nationality,
        phone: t.phone,
        notes: t.notes,
      })),
    };
  }

  async update(id: string, body: UpdateCustomerBody) {
    const u = await prisma.user.findUnique({ where: { id }, include: { customerProfile: true } });
    if (!u || u.role !== 'CUSTOMER') throw new NotFoundError('客户不存在');

    // 合并更新 User + CustomerProfile
    const updated = await prisma.$transaction(async (tx) => {
      const userData: Prisma.UserUpdateInput = {};
      if (body.displayName !== undefined) userData.displayName = body.displayName;
      if (body.phone !== undefined) userData.phone = body.phone;
      if (body.email !== undefined) userData.email = body.email;
      if (Object.keys(userData).length > 0) {
        await tx.user.update({ where: { id }, data: userData });
      }

      // upsert profile
      const profileData: Prisma.CustomerProfileUpsertArgs['create'] = { userId: id };
      const profileUpdate: Prisma.CustomerProfileUpdateInput = {};
      if (body.idNumber !== undefined) profileUpdate.idNumber = body.idNumber;
      if (body.primaryAgentId !== undefined) {
        profileUpdate.primaryAgent = body.primaryAgentId
          ? { connect: { id: body.primaryAgentId } }
          : { disconnect: true };
        if (body.primaryAgentId) profileData.primaryAgentId = body.primaryAgentId;
      }
      if (body.tags !== undefined) { profileUpdate.tags = body.tags; profileData.tags = body.tags; }
      if (body.notes !== undefined) { profileUpdate.notes = body.notes; profileData.notes = body.notes; }

      if (Object.keys(profileUpdate).length > 0 || !u.customerProfile) {
        await tx.customerProfile.upsert({
          where: { userId: id },
          update: profileUpdate,
          create: { ...profileData, idNumber: body.idNumber ?? null, notes: body.notes ?? null, tags: body.tags ?? [] },
        });
      }

      return tx.user.findUniqueOrThrow({
        where: { id },
        include: {
          customerProfile: { include: { primaryAgent: { select: { id: true, companyName: true, contactName: true, tier: true } } } },
        },
      });
    });

    return serializeCustomer(updated);
  }
}

// ── Serializer ──────────────────────────────────────────────────
type CustomerRow = Prisma.UserGetPayload<{
  include: {
    customerProfile: {
      include: {
        primaryAgent: { select: { id: true; companyName: true; contactName: true; tier: true } };
      };
    };
  };
}>;

function serializeCustomer(u: CustomerRow, agg?: { orders: number; spent: number; lastAt: Date | null }) {
  return {
    id: u.id,
    displayName: u.displayName,
    email: u.email,
    phone: u.phone,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    profile: u.customerProfile
      ? {
          idNumber: u.customerProfile.idNumber,
          primaryAgentId: u.customerProfile.primaryAgentId,
          primaryAgent: u.customerProfile.primaryAgent,
          tags: u.customerProfile.tags,
          notes: u.customerProfile.notes,
        }
      : {
          idNumber: null, primaryAgentId: null, primaryAgent: null, tags: [], notes: null,
        },
    totalOrders: agg?.orders ?? 0,
    totalSpent: agg?.spent ?? 0,
    lastOrderAt: agg?.lastAt ?? null,
  };
}

void BadRequestError;
