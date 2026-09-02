/**
 * 套餐改档申请服务 —— 代理提申请、运营确认后才调用既有套餐改档通道。
 *
 * 提交 / 驳回只改申请表；真正会改套餐行、住宿和订单金额的动作只发生在 approve()。
 */
import { BundleChangeRequestStatus, OrderStatus, Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { getDescendantAgentIds } from '../../lib/agent-tree.js';
import {
  CHANGE_BUNDLE_ITEM_SELECT,
  OrderService,
  assertOrderChangeBundleAllowed,
  resolveChangeableBundleRow,
} from '../orders/orders.service.js';
import type {
  CreateBundleChangeRequestBody,
  DecideBundleChangeRequestBody,
  ListBundleChangeRequestsQuery,
} from './bundle-change-requests.schemas.js';

export const BUNDLE_CHANGE_REQUEST_REASON_TEXT = '代理改档申请（运营确认）';
/** 确认执行的处理中占位有效期：超过视为上次执行中途挂掉，允许再次确认。 */
export const APPROVE_CLAIM_TTL_MS = 2 * 60 * 1000;
export const BUNDLE_CHANGE_NIGHTS_WARNING =
  '目标套餐晚数与原套餐不同：酒店离店日已按新晚数重算，但回程航班不会自动改，请到回程航段行另行改期';

export interface BundleChangeRequestActor {
  userId: string;
  role: UserRole;
}

type BundleChangeRequestRow = {
  id: string;
  orderId: string;
  agentId: string | null;
  requestedById: string;
  fromBundleId: string;
  fromBundleName: string;
  fromNights: number | null;
  toBundleId: string;
  toBundleName: string;
  toNights: number | null;
  note: string | null;
  status: BundleChangeRequestStatus;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  appliedAt: Date | null;
  appliedDiffCny: Prisma.Decimal | null;
  appliedDiffItemId: string | null;
  createdAt: Date;
  agent?: { id: string; companyName: string | null; contactName: string } | null;
  order?: {
    orderNumber: string;
    _count: { passengers: number };
  } | null;
};

function nightsChanged(fromNights: number | null, toNights: number | null): boolean {
  return fromNights !== null && toNights !== null && fromNights !== toNights;
}

function serializeBundleChangeRequest(r: BundleChangeRequestRow) {
  return {
    id: r.id,
    orderId: r.orderId,
    orderNumber: r.order?.orderNumber ?? null,
    agentId: r.agentId,
    agentName: r.agent ? r.agent.companyName || r.agent.contactName : null,
    passengerCount: r.order?._count.passengers ?? null,
    requestedById: r.requestedById,
    fromBundleId: r.fromBundleId,
    fromBundleName: r.fromBundleName,
    fromNights: r.fromNights,
    toBundleId: r.toBundleId,
    toBundleName: r.toBundleName,
    toNights: r.toNights,
    nightsChanged: nightsChanged(r.fromNights, r.toNights),
    note: r.note,
    status: r.status,
    decidedById: r.decidedById,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    appliedAt: r.appliedAt?.toISOString() ?? null,
    appliedDiffCny: r.appliedDiffCny?.toString() ?? null,
    appliedDiffItemId: r.appliedDiffItemId,
    createdAt: r.createdAt.toISOString(),
  };
}
export type SerializedBundleChangeRequest = ReturnType<typeof serializeBundleChangeRequest>;

const REQUEST_INCLUDE = {
  agent: { select: { id: true, companyName: true, contactName: true } },
  order: {
    select: {
      orderNumber: true,
      _count: { select: { passengers: true } },
    },
  },
} as const;

export class BundleChangeRequestsService {
  constructor(private readonly orders: OrderService = new OrderService()) {}

  private async resolveOwnAgentId(userId: string): Promise<string> {
    const agent = await prisma.agent.findUnique({ where: { userId }, select: { id: true } });
    if (!agent) throw new ForbiddenError('当前用户不是代理');
    return agent.id;
  }

  private async visibleAgentIds(userId: string): Promise<string[]> {
    return getDescendantAgentIds(await this.resolveOwnAgentId(userId));
  }

  async create(
    actor: BundleChangeRequestActor,
    orderId: string,
    body: CreateBundleChangeRequestBody,
  ): Promise<SerializedBundleChangeRequest> {
    let ownAgentId: string | null = null;
    if (actor.role === UserRole.AGENT) {
      ownAgentId = await this.resolveOwnAgentId(actor.userId);
    } else if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('无权限提交改档申请');
    }

    try {
      const created = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
        const order = await tx.order.findUnique({
          where: { id: orderId },
          select: {
            id: true,
            orderNumber: true,
            agentId: true,
            status: true,
            deletedAt: true,
            items: { select: CHANGE_BUNDLE_ITEM_SELECT },
          },
        });
        if (!order || order.deletedAt) throw new NotFoundError('订单不存在');

        if (ownAgentId && order.agentId !== ownAgentId) {
          throw new ForbiddenError('只能对自己名下的订单提交改档申请');
        }
        assertOrderChangeBundleAllowed(order);
        const { row: bundleRow, bundleId: fromBundleId } = resolveChangeableBundleRow(
          order.items,
          body.bundleId,
        );

        const targetBundle = await tx.bundle.findUnique({
          where: { id: body.bundleId },
          select: { id: true, name: true, isActive: true, settlementNights: true },
        });
        if (!targetBundle) throw new NotFoundError(`套餐 ${body.bundleId} 不存在`);
        if (!targetBundle.isActive) throw new BadRequestError('目标套餐已下架');

        const currentBundle = await tx.bundle.findUnique({
          where: { id: fromBundleId },
          select: { id: true, name: true, settlementNights: true },
        });
        let fromBundleName = currentBundle?.name ?? '';
        if (!currentBundle) {
          const currentItem = await tx.orderItem.findUnique({
            where: { id: bundleRow.id },
            select: { description: true },
          });
          fromBundleName = currentItem?.description ?? fromBundleId;
        }

        const pending = await tx.bundleChangeRequest.findFirst({
          where: { orderId, status: BundleChangeRequestStatus.PENDING },
          select: { id: true },
        });
        if (pending) {
          throw new ConflictError('该订单已有一条待确认的改档申请，请等运营处理后再提交');
        }

        return tx.bundleChangeRequest.create({
          data: {
            orderId,
            agentId: order.agentId,
            requestedById: actor.userId,
            fromBundleId,
            fromBundleName,
            fromNights: currentBundle?.settlementNights ?? null,
            toBundleId: targetBundle.id,
            toBundleName: targetBundle.name,
            toNights: targetBundle.settlementNights,
            note: body.note?.trim() || null,
            status: BundleChangeRequestStatus.PENDING,
          },
          include: REQUEST_INCLUDE,
        });
      });
      return serializeBundleChangeRequest(created as BundleChangeRequestRow);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictError('该订单已有一条待确认的改档申请，请等运营处理后再提交');
      }
      throw err;
    }
  }

  async listForOrder(
    actor: BundleChangeRequestActor,
    orderId: string,
  ): Promise<{ requests: SerializedBundleChangeRequest[] }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, agentId: true, deletedAt: true },
    });
    if (!order || order.deletedAt) throw new NotFoundError('订单不存在');

    if (actor.role === UserRole.AGENT) {
      const visible = await this.visibleAgentIds(actor.userId);
      if (!order.agentId || !visible.includes(order.agentId)) {
        throw new ForbiddenError('无权查看该订单的改档申请');
      }
    } else if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('无权限查看改档申请');
    }

    const rows = await prisma.bundleChangeRequest.findMany({
      where: { orderId },
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return { requests: rows.map((row) => serializeBundleChangeRequest(row as BundleChangeRequestRow)) };
  }

  async list(actor: BundleChangeRequestActor, query: ListBundleChangeRequestsQuery) {
    const where: Prisma.BundleChangeRequestWhereInput = {};
    if (query.status) where.status = query.status;

    if (actor.role === UserRole.AGENT) {
      where.agentId = { in: await this.visibleAgentIds(actor.userId) };
    } else if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('无权限查看改档申请');
    }

    const [rows, total] = await prisma.$transaction([
      prisma.bundleChangeRequest.findMany({
        where,
        include: REQUEST_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: query.pageSize,
        skip: (query.page - 1) * query.pageSize,
      }),
      prisma.bundleChangeRequest.count({ where }),
    ]);

    return {
      requests: rows.map((row) => serializeBundleChangeRequest(row as BundleChangeRequestRow)),
      pagination: { page: query.page, pageSize: query.pageSize, total },
    };
  }

  async approve(
    actor: BundleChangeRequestActor,
    id: string,
    body: DecideBundleChangeRequestBody,
  ): Promise<{
    request: SerializedBundleChangeRequest;
    order: unknown;
    diffCny: number;
    warnings: string[];
    changeAudit: {
      orderNumber: string;
      orderItemId: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      diffCny: number;
      diffItemId: string | null;
      pricingSource: 'SETTLEMENT_CALENDAR' | 'BUNDLE_PRICE';
      note: string | null;
      warnings: string[];
    };
    audit: { orderId: string; orderNumber: string; requestedById: string };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可确认改档申请');
    }

    const claim = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          orderId: string;
          toBundleId: string;
          fromNights: number | null;
          toNights: number | null;
          note: string | null;
          status: BundleChangeRequestStatus;
          requestedById: string;
          decidedAt: Date | null;
        }>
      >`SELECT id, "orderId", "toBundleId", "fromNights", "toNights", note, status, "requestedById", "decidedAt" FROM "BundleChangeRequest" WHERE id = ${id} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new NotFoundError('改档申请不存在');
      if (row.status !== BundleChangeRequestStatus.PENDING) {
        throw new ConflictError(`该申请当前状态为 ${row.status}，不可重复处理`);
      }
      // 处理中标记：status 仍是 PENDING（「一单一条待确认」的部分唯一索引因此在执行期间照样生效，
      // 代理这会儿插不进第二条），只用 decidedAt 占位。占位超过 APPROVE_CLAIM_TTL_MS 视为上次执行
      // 中途挂掉，允许重试（目标套餐若已换成功，changeOrderBundle 会以「同一套餐」拒绝，不会重复执行）。
      if (row.decidedAt && Date.now() - row.decidedAt.getTime() < APPROVE_CLAIM_TTL_MS) {
        throw new ConflictError('该申请正在处理中，请稍后刷新查看结果');
      }

      const order = await tx.order.findUnique({
        where: { id: row.orderId },
        select: { id: true, orderNumber: true, deletedAt: true },
      });
      if (!order || order.deletedAt) throw new NotFoundError('订单不存在');

      await tx.bundleChangeRequest.update({
        where: { id },
        data: {
          decidedById: actor.userId,
          decidedAt: new Date(),
          decisionNote: body.note?.trim() || null,
        },
      });

      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        requestedById: row.requestedById,
        toBundleId: row.toBundleId,
        note: row.note,
        nightsChanged: nightsChanged(row.fromNights, row.toNights),
      };
    });

    let applied: Awaited<ReturnType<OrderService['changeOrderBundle']>>;
    try {
      applied = await this.orders.changeOrderBundle(
        claim.orderId,
        {
          bundleId: claim.toBundleId,
          note: `${BUNDLE_CHANGE_REQUEST_REASON_TEXT}${claim.note ? `：${claim.note}` : ''}`,
        },
        actor,
      );
    } catch (err) {
      // 改档没落地 → 撤掉处理中标记，申请原样留在队列里（状态一直是 PENDING，不存在撞唯一索引的问题）。
      await prisma.bundleChangeRequest.updateMany({
        where: { id, status: BundleChangeRequestStatus.PENDING, appliedAt: null },
        data: { decidedById: null, decidedAt: null, decisionNote: null },
      });
      throw err;
    }

    const changeAudit = applied.audit;
    const warnings = [...changeAudit.warnings];
    if (claim.nightsChanged) warnings.push(BUNDLE_CHANGE_NIGHTS_WARNING);
    await prisma.bundleChangeRequest.update({
      where: { id },
      data: {
        status: BundleChangeRequestStatus.APPROVED,
        appliedAt: new Date(),
        appliedDiffCny: new Prisma.Decimal(changeAudit.diffCny),
        appliedDiffItemId: changeAudit.diffItemId,
      },
    });

    const finalRow = await prisma.bundleChangeRequest.findUniqueOrThrow({
      where: { id },
      include: REQUEST_INCLUDE,
    });
    return {
      request: serializeBundleChangeRequest(finalRow as BundleChangeRequestRow),
      order: applied.order,
      diffCny: changeAudit.diffCny,
      warnings,
      changeAudit,
      audit: {
        orderId: claim.orderId,
        orderNumber: claim.orderNumber,
        requestedById: claim.requestedById,
      },
    };
  }

  async reject(
    actor: BundleChangeRequestActor,
    id: string,
    body: DecideBundleChangeRequestBody,
  ): Promise<{
    request: SerializedBundleChangeRequest;
    audit: { orderId: string; orderNumber: string | null; requestedById: string };
  }> {
    if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.STAFF) {
      throw new ForbiddenError('仅运营/管理员可驳回改档申请');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; orderId: string; status: BundleChangeRequestStatus; requestedById: string }>
      >`SELECT id, "orderId", status, "requestedById" FROM "BundleChangeRequest" WHERE id = ${id} FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new NotFoundError('改档申请不存在');
      if (row.status !== BundleChangeRequestStatus.PENDING) {
        throw new ConflictError(`该申请当前状态为 ${row.status}，不可重复处理`);
      }
      return tx.bundleChangeRequest.update({
        where: { id },
        data: {
          status: BundleChangeRequestStatus.REJECTED,
          decidedById: actor.userId,
          decidedAt: new Date(),
          decisionNote: body.note?.trim() || null,
        },
        include: REQUEST_INCLUDE,
      });
    });

    return {
      request: serializeBundleChangeRequest(updated as BundleChangeRequestRow),
      audit: {
        orderId: updated.orderId,
        orderNumber: (updated as BundleChangeRequestRow).order?.orderNumber ?? null,
        requestedById: updated.requestedById,
      },
    };
  }
}
