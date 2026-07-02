/**
 * 代理认款通道路由 —— 代理上传付款凭证认款，财务核实后确认入代理预存余额。
 *
 * 注册前缀 /agent-recharges：
 *   POST   /agent-recharges              提交认款申请（AGENT 为自己；ADMIN/STAFF 可代提交）
 *   GET    /agent-recharges              列表（ADMIN/STAFF 全部；AGENT 仅自己 + 下级）
 *   GET    /agent-recharges/my-channels  AGENT 专用：应付款到哪个收款渠道（专属码优先，否则公司码）
 *   PATCH  /agent-recharges/:id/confirm  确认到账（ADMIN/STAFF）
 *   PATCH  /agent-recharges/:id/reject   驳回（ADMIN/STAFF）
 *   POST   /agent-recharges/manual-adjust 手动调整余额（ADMIN/STAFF，线下对账修正用）
 *
 * 余额只能从「认款确认」或「手动调整」充进来，不许赊账（Agent.prepaymentBalance 永不为负）。
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { AgentRechargesService } from './agent-recharges.service.js';
import {
  confirmRechargeRequestSchema,
  createRechargeRequestSchema,
  listRechargeRequestsQuerySchema,
  manualBalanceAdjustmentSchema,
  rejectRechargeRequestSchema,
} from './agent-recharges.schemas.js';

export const agentRechargeRoutes: FastifyPluginAsync = async (app) => {
  const service = new AgentRechargesService();
  const requireAdminOrStaff = app.requireRole(UserRole.ADMIN, UserRole.STAFF);
  const requireAnyStaffRole = app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT);

  // ── 提交认款申请 ─────────────────────────────────────
  app.post(
    '/',
    { preHandler: [app.authenticate, requireAnyStaffRole] },
    async (req, reply) => {
      const body = createRechargeRequestSchema.parse(req.body);
      const request = await service.create(
        { userId: req.user.sub, role: req.user.role },
        body,
      );
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'CREATE_AGENT_RECHARGE_REQUEST',
        targetType: 'AGENT',
        targetId: request.agentId,
        targetLabel: request.id,
        after: { amountCny: request.amountCny, proofCount: request.proofImages.length },
      });
      return reply.status(201).send({ request });
    },
  );

  // ── 列表 ─────────────────────────────────────────────
  app.get(
    '/',
    { preHandler: [app.authenticate, requireAnyStaffRole] },
    async (req) => {
      const query = listRechargeRequestsQuerySchema.parse(req.query);
      const result = await service.list({ userId: req.user.sub, role: req.user.role }, query);
      return result;
    },
  );

  // ── AGENT：应付款渠道 ────────────────────────────────
  app.get(
    '/my-channels',
    { preHandler: [app.authenticate, app.requireRole(UserRole.AGENT)] },
    async (req) => {
      const result = await service.myChannels({ userId: req.user.sub, role: req.user.role });
      return result;
    },
  );

  // ── 确认到账 ─────────────────────────────────────────
  app.patch(
    '/:id/confirm',
    { preHandler: [app.authenticate, requireAdminOrStaff] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = confirmRechargeRequestSchema.parse(req.body);
      const { request, agentBalanceAfter } = await service.confirm(
        { userId: req.user.sub, role: req.user.role },
        id,
        body,
      );
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'CONFIRM_AGENT_RECHARGE',
        targetType: 'AGENT',
        targetId: request.agentId,
        targetLabel: request.id,
        after: {
          confirmedAmountCny: request.confirmedAmountCny,
          agentBalanceAfter,
          prepaymentTxId: request.prepaymentTxId,
        },
        severity: 'WARNING',
      });
      return { request, agentBalanceAfter };
    },
  );

  // ── 驳回 ─────────────────────────────────────────────
  app.patch(
    '/:id/reject',
    { preHandler: [app.authenticate, requireAdminOrStaff] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = rejectRechargeRequestSchema.parse(req.body);
      const request = await service.reject({ userId: req.user.sub, role: req.user.role }, id, body);
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'REJECT_AGENT_RECHARGE',
        targetType: 'AGENT',
        targetId: request.agentId,
        targetLabel: request.id,
        after: { reviewNote: request.reviewNote },
        severity: 'WARNING',
      });
      return { request };
    },
  );

  // ── 手动调整余额（线下对账修正） ─────────────────────
  app.post(
    '/manual-adjust',
    { preHandler: [app.authenticate, requireAdminOrStaff] },
    async (req) => {
      const body = manualBalanceAdjustmentSchema.parse(req.body);
      const result = await service.manualAdjust({ userId: req.user.sub, role: req.user.role }, body);
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'MANUAL_ADJUST_AGENT_BALANCE',
        targetType: 'AGENT',
        targetId: result.agentId,
        targetLabel: `${result.amount >= 0 ? '+' : ''}${result.amount}`,
        after: { amount: result.amount, balanceAfter: result.balanceAfter, reason: body.reason },
        severity: 'WARNING',
      });
      return result;
    },
  );
};
