/**
 * 结算价议价申请路由。
 *
 * 挂在 /orders 前缀（在 app.ts 用 prefix:'/orders' 注册 orderSettlementRequestRoutes）：
 *   POST /orders/:id/settlement-requests   代理（限本单归属代理）或运营提交申请
 *     两种作用范围二选一：整单传 requestedTotalCny（想收多少），
 *     指定乘客传 passengerId + adjustmentCny（只给这个人加/减多少的调整净额）。
 *   GET  /orders/:id/settlement-requests   本单全部申请
 *
 * 提交的返回体带 selfApplied：true = 代理在未锁价的自家单上自助改价、已当场生效（审计
 * AGENT_SELF_SETTLEMENT）；false = 只落了一条待运营确认的申请，订单金额未动。
 *
 * 挂在 /settlement-requests 前缀：
 *   GET  /settlement-requests              待办队列（AGENT 调用只返回自家 + 下级）
 *   POST /settlement-requests/:id/approve  确认（ADMIN/STAFF）→ 走既有调价通道生成差额行
 *   POST /settlement-requests/:id/reject   驳回（ADMIN/STAFF）
 *
 * 钱只有两种动法，都由服务端按既有调价通道生成差额行：代理在未锁价的自家单上自助改价（提交
 * 当场生效），或运营确认一条待确认申请。其余任何提交都改不动订单金额。
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { SettlementRequestsService } from './settlement-requests.service.js';
import {
  createSettlementRequestBodySchema,
  decideSettlementRequestBodySchema,
  listSettlementRequestsQuerySchema,
} from './settlement-requests.schemas.js';

const service = new SettlementRequestsService();

// ── 挂在 /orders 前缀 ────────────────────────────────────────────────
export const orderSettlementRequestRoutes: FastifyPluginAsync = async (app) => {
  const requireAgentOrOps = app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT);

  // 提交议价申请
  app.post(
    '/:id/settlement-requests',
    { preHandler: [app.authenticate, requireAgentOrOps] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = createSettlementRequestBodySchema.parse(req.body);
      const request = await service.create({ userId: req.user.sub, role: req.user.role }, id, body);
      void writeAudit({
        actor: actorFromRequest(req),
        // 自助直通改的是真金白银的应收，且没有第二个人经手 → 独立 action + WARNING 级，
        // 财务复核能把它与「等运营确认」的申请分开筛。落 PENDING 的照旧是创建流水（INFO）。
        action: request.selfApplied ? 'AGENT_SELF_SETTLEMENT' : 'SETTLEMENT_REQUEST_CREATED',
        targetType: 'ORDER',
        targetId: id,
        targetLabel: request.orderNumber ?? undefined,
        after: {
          requestId: request.id,
          agentId: request.agentId,
          requestedTotalCny: request.requestedTotalCny,
          systemTotalCny: request.systemTotalCny,
          // 自助直通：实际落地的差额（申请价 − 提交那一刻的应收）；
          // 落 PENDING 时是「现在还差多少」（申请价 − 当前应收），口径与队列一致。
          diffCny: request.selfApplied ? request.appliedDiffCny : request.diffCny,
          // 自助直通生成的差额行 id（落 PENDING 时为 null，钱还没动）。
          appliedAdjustmentItemId: request.appliedAdjustmentItemId,
          requestedById: request.requestedById,
          selfApplied: request.selfApplied,
          // 作用范围：非空 = 只调了这一位乘客的份额（财务复核要分得清改的是整单还是某个人）。
          passengerId: request.passengerId,
          passengerName: request.passengerName,
          requestedAdjustmentCny: request.requestedAdjustmentCny,
          note: request.note,
        },
        ...(request.selfApplied ? { severity: 'WARNING' as const } : {}),
      });
      return reply.status(201).send({ request });
    },
  );

  // 本单全部申请
  app.get(
    '/:id/settlement-requests',
    { preHandler: [app.authenticate, requireAgentOrOps] },
    async (req) => {
      const { id } = req.params as { id: string };
      return service.listForOrder({ userId: req.user.sub, role: req.user.role }, id);
    },
  );
};

// ── 挂在 /settlement-requests 前缀 ───────────────────────────────────
export const settlementRequestRoutes: FastifyPluginAsync = async (app) => {
  const requireOps = app.requireRole(UserRole.ADMIN, UserRole.STAFF);
  const requireAgentOrOps = app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT);

  // 待办队列
  app.get('/', { preHandler: [app.authenticate, requireAgentOrOps] }, async (req) => {
    const query = listSettlementRequestsQuerySchema.parse(req.query);
    return service.list({ userId: req.user.sub, role: req.user.role }, query);
  });

  // 确认 —— 差额行由既有调价通道生成，订单金额只在这一步动
  app.post('/:id/approve', { preHandler: [app.authenticate, requireOps] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = decideSettlementRequestBodySchema.parse(req.body);
    const { request, order, audit } = await service.approve(
      { userId: req.user.sub, role: req.user.role },
      id,
      body,
    );
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'SETTLEMENT_REQUEST_APPROVED',
      targetType: 'ORDER',
      targetId: audit.orderId,
      targetLabel: audit.orderNumber,
      before: { status: 'PENDING', receivableCny: audit.currentTotalCny },
      after: {
        requestId: request.id,
        status: request.status,
        requestedTotalCny: audit.requestedTotalCny,
        currentTotalCny: audit.currentTotalCny,
        diffCny: audit.diffCny,
        requestedById: audit.requestedById,
        decidedById: request.decidedById,
        decisionNote: request.decisionNote,
        itemId: audit.itemId,
        // 作用范围：非空 = 差额行只挂在这一位乘客名下。
        passengerId: audit.passengerId,
        passengerName: request.passengerName,
      },
      severity: 'WARNING',
    });
    return { request, order };
  });

  // 驳回
  app.post('/:id/reject', { preHandler: [app.authenticate, requireOps] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = decideSettlementRequestBodySchema.parse(req.body);
    const { request, audit } = await service.reject(
      { userId: req.user.sub, role: req.user.role },
      id,
      body,
    );
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'SETTLEMENT_REQUEST_REJECTED',
      targetType: 'ORDER',
      targetId: audit.orderId,
      targetLabel: request.orderNumber ?? undefined,
      before: { status: 'PENDING' },
      after: {
        requestId: request.id,
        status: request.status,
        requestedTotalCny: request.requestedTotalCny,
        currentTotalCny: request.currentTotalCny,
        diffCny: request.diffCny,
        requestedById: audit.requestedById,
        decidedById: request.decidedById,
        decisionNote: request.decisionNote,
      },
      severity: 'WARNING',
    });
    return { request };
  });
};
