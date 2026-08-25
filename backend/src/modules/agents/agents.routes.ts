import type { FastifyPluginAsync } from 'fastify';
import { Prisma, ProductKind, UserRole } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import { AgentService } from './agents.service.js';
import {
  createChildAgentBodySchema,
  setAgentStatusBodySchema,
  setSettlementModeBodySchema,
  updateAgentBodySchema,
} from './agents.schemas.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { localToUtc } from '../../lib/flight-time.js';
import { BUSINESS_TZ, businessDateISO } from '../../lib/business-time.js';

export const agentRoutes: FastifyPluginAsync = async (app) => {
  const service = new AgentService();

  // 列表：AGENT 看自己 + 所有后代；ADMIN/STAFF 看全部
  app.get(
    '/',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT)] },
    async (req) => {
      const agents = await service.listVisibleAgents(req.user.sub, req.user.role);
      return { agents };
    },
  );

  // 当前登录用户自己的 agent profile（AGENT 专用）
  app.get(
    '/me',
    { preHandler: [app.authenticate, app.requireRole(UserRole.AGENT, UserRole.ADMIN)] },
    async (req) => {
      const agent = await service.getByUserId(req.user.sub);
      return { agent };
    },
  );

  // 创建下级代理。
  //  - AGENT: POST /agents/children  (父=自己)
  //  - ADMIN/STAFF: POST /agents/children?parentId=xxx  可指定；省略 = 建 1 级代理
  app.post(
    '/children',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT)] },
    async (req, reply) => {
      const body = createChildAgentBodySchema.parse(req.body);
      const { parentId } = (req.query as { parentId?: string }) ?? {};
      const result = await service.createChildAgent({
        currentUserId: req.user.sub,
        currentRole: req.user.role,
        parentAgentId: parentId ?? null,
        body,
      });
      // 建代理留审计：记操作人 + 新代理 id + 层级/上级（不记余额——建代理余额恒为 0，
      // 余额变动一律走认款通道并在那里各自留审计）。
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'CREATE_CHILD_AGENT',
        targetType: 'AGENT',
        targetId: result.agent.id,
        targetLabel: result.agent.contactName,
        after: { tier: result.agent.tier, parentAgentId: result.agent.parentAgentId },
        severity: 'WARNING',
      });
      return reply.status(201).send(result);
    },
  );

  // 设置代理结算模式（PER_ORDER 逐单到账 / MONTHLY 月结挂账）。仅 ADMIN。
  // PATCH /agents/:id/settlement-mode  body: { settlementMode }
  app.patch(
    '/:id/settlement-mode',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = setSettlementModeBodySchema.parse(req.body);
      const result = await service.setSettlementMode(id, body.settlementMode, req.user.role);
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'SET_AGENT_SETTLEMENT_MODE',
        targetType: 'AGENT',
        targetId: id,
        targetLabel: result.contactName,
        before: { settlementMode: result.previousMode },
        after: { settlementMode: result.settlementMode },
        severity: 'WARNING',
      });
      return result;
    },
  );

  // 编辑代理基础联系信息（公司名/联系人/电话/邮箱/备注）。
  // ADMIN/STAFF 可改任意代理；AGENT 只能改自己。
  // PATCH /agents/:id
  app.patch(
    '/:id',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF, UserRole.AGENT)] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = updateAgentBodySchema.parse(req.body);
      const result = await service.updateAgent({
        currentUserId: req.user.sub,
        currentRole: req.user.role,
        targetAgentId: id,
        body,
      });
      if (result.changedFields.length > 0) {
        void writeAudit({
          actor: actorFromRequest(req),
          action: 'UPDATE_AGENT',
          targetType: 'AGENT',
          targetId: id,
          targetLabel: result.agent.contactName,
          before: result.before,
          after: result.after,
          severity: 'INFO',
        });
      }
      return { agent: result.agent };
    },
  );

  // 停用/启用代理登录。仅 ADMIN。停用后该代理对应账号无法再登录（见 AuthService.login）；
  // 不级联停用下级代理。
  // PATCH /agents/:id/status  body: { isActive }
  app.patch(
    '/:id/status',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN)] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = setAgentStatusBodySchema.parse(req.body);
      const result = await service.setActive({
        currentUserId: req.user.sub,
        currentRole: req.user.role,
        targetAgentId: id,
        isActive: body.isActive,
      });
      if (result.changed) {
        void writeAudit({
          actor: actorFromRequest(req),
          action: body.isActive ? 'ACTIVATE_AGENT' : 'DEACTIVATE_AGENT',
          targetType: 'AGENT',
          targetId: id,
          targetLabel: result.agent.contactName,
          before: { isActive: !body.isActive },
          after: { isActive: body.isActive },
          severity: 'WARNING',
        });
      }
      return { agent: result.agent };
    },
  );

  // ── 佣金规则（A1，2026-07-17）：CommissionRule 此前全仓只读（写入口仅 seed），
  // 缺规则时计提静默按 0 佣金——代理拿不到钱还查无此账。这里补上管理端读写：
  //   GET  /:id/commission-rules   当前生效费率（每 productKind 一条，取最新生效）+
  //                                待生效费率（0825 复审补：每 productKind 取最早的未来生效
  //                                规则——见下方 upcoming 字段注释）
  //   PUT  /:id/commission-rules   仅 ADMIN；每个传入的 kind 追加一条新规则（历史保留；
  //                                计提读「最新生效」自然切换，不改旧账）。effectiveFrom
  //                                可选：省略 = 此刻生效（原行为不变）；传入 YYYY-MM-DD
  //                                则从这天起飞的订单开始按新费率计提（详见下方 schema 注释）。
  const COMMISSION_KINDS = [
    ProductKind.FLIGHT,
    ProductKind.HOTEL,
    ProductKind.TRANSFER,
    ProductKind.VISA,
    // 套餐是独立一档，不复用机票费率：套餐单的 BUNDLE 行（地面+加项）走本档，
    // 同单的机票腿仍走 FLIGHT 档，两者互不重叠。
    ProductKind.BUNDLE,
  ] as const;

  // 'YYYY-MM-DD' 严格校验（拒绝 2026-02-30 这类日历上不存在的日期，正则本身只管格式）。
  const EFFECTIVE_FROM_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function isValidCalendarDate(s: string): boolean {
    const d = new Date(`${s}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  // 今天的**业务日（上海）**——与下面「日期字符串 → 上海零点」的落库口径自洽。
  // 用上海而非 UTC：运营在北京时间凌晨 0–8 点填「今天」时，按 UTC 算还停在昨天，会被下限误拒。
  function todayBusinessDateISO(): string {
    return businessDateISO(new Date());
  }

  const putCommissionRulesBodySchema = z.object({
    rates: z
      .record(
        // 与 COMMISSION_KINDS 同步——漏掉哪个 kind，PUT 就会把该档费率静默丢弃（zod
        // record 对未声明的键直接剔除），运营在页面上填了却存不进去。
        z.enum(['FLIGHT', 'HOTEL', 'TRANSFER', 'VISA', 'BUNDLE']),
        z
          .number()
          .min(0, '费率不能为负')
          .max(0.5, '费率超出上限（50%）——按小数填，如 0.05 = 5%'),
      )
      .refine((r) => Object.keys(r).length > 0, '至少提供一个产品类型的费率'),
    // 生效日（可选，YYYY-MM-DD）：省略 = 沿用现状「此刻生效」（既有调用方行为不变）。
    // 传入则落库为该日期的 UTC 零点（与 orders.service.ts 里其它 date-only 字段的既有
    // 口径一致——见该文件 formatDateOnly() 的注释：「date-only 字段本就存 UTC 零点」），
    // 计提侧预期按订单出发日（date-only）与它比较，两边都取「日期字符串→UTC 零点」
    // 才不会出现 9/1 当天起飞的单被判定成差一天不生效。
    // 下限＝不早于今天：允许追溯生效会让"按出发日计提"里已经临近出发甚至已在途的订单
    // 被意外套用新费率，制造运营没预期到的历史口径变化；上限不设——放开未来日期正是本次改动的目的。
    effectiveFrom: z
      .string()
      .regex(EFFECTIVE_FROM_DATE_RE, '生效日格式应为 YYYY-MM-DD')
      .refine(isValidCalendarDate, '生效日不是合法日期')
      .refine((s) => s >= todayBusinessDateISO(), '生效日不能早于今天')
      .optional(),
  });

  app.get(
    '/:id/commission-rules',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const { id } = req.params as { id: string };
      const agent = await prisma.agent.findUnique({ where: { id }, select: { id: true } });
      if (!agent) throw new NotFoundError('代理不存在');
      const now = new Date();
      // 展示口径 = 「此刻生效」：按 now 过滤，effectiveFrom DESC 每 kind 取第一条。
      // 与计提口径（createCommissionsForOrder）有意不同——那边比的是**订单出发日**当天生效的规则
      // （佣金按出发日算，8/30 起飞的单不吃 9/1 才生效的费率）。本页答的是「代理当前费率是多少」，
      // 比 now 才是对的；两者出现差异属预期，别照着计提那边改成比出发日。
      const rows = await prisma.commissionRule.findMany({
        where: {
          agentId: id,
          effectiveFrom: { lte: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
        },
        orderBy: { effectiveFrom: 'desc' },
      });
      const current: Record<string, { rate: number; effectiveFrom: string } | null> = {};
      for (const kind of COMMISSION_KINDS) {
        const hit = rows.find((r) => r.productKind === kind);
        current[kind] = hit
          ? { rate: Number(hit.rate), effectiveFrom: hit.effectiveFrom.toISOString() }
          : null; // null = 无规则 → 计提按 0（缺规则不再是隐形的）
      }

      // 待生效（0825 复审补）：财务今天配一条「9/1 起生效」的费率，本页此前只答"当前生效"，
      // 保存成功后重新打开页面还是显示旧费率——财务大概率以为没存上，重复保存或改错数字。
      // 这里单独再查一遍 effectiveFrom > now 的规则，每档取**最早**的一条：那就是财务刚配的、
      // 离生效最近的下一条，也是本页要回答"我刚存的东西确实在库里"这个问题时最相关的一条。
      // 同一档排了不止一条未来规则属边缘情况（比如同时配了 9/1 和 10/1）——这里不展示全部排期，
      // 只保证"最快要生效的那条不会被吞"；更完整的排期视图不在本次范围内。
      // effectiveTo 过滤沿用上面 current 查询的写法：目前全仓没有任何写入口给 CommissionRule
      // 设置过 effectiveTo（该字段只在 finances.cost.service.ts 的另一张表里用到），保留这个过滤
      // 只是为了防御性地和 current 的口径保持一致，不依赖"当前恰好没人写它"这个事实。
      const upcomingRows = await prisma.commissionRule.findMany({
        where: {
          agentId: id,
          effectiveFrom: { gt: now },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
        },
        orderBy: { effectiveFrom: 'asc' },
      });
      const upcoming: Record<string, { rate: number; effectiveFrom: string } | null> = {};
      for (const kind of COMMISSION_KINDS) {
        const hit = upcomingRows.find((r) => r.productKind === kind);
        upcoming[kind] = hit
          ? { rate: Number(hit.rate), effectiveFrom: hit.effectiveFrom.toISOString() }
          : null; // null = 该档没有排队中的未来规则
      }

      return { rules: current, upcoming };
    },
  );

  // 写权限放开至内部岗位（ADMIN + STAFF）：返佣政策的口径归财务，只让 ADMIN 写会让财务每次配费率
  // 都要绕人，规则永远配不齐。代理/散客够不到本路由（AGENT 角色不在 requireRole 名单里）。
  // 动费率=动钱，审计照旧 severity=WARNING 逐次留痕，改了什么、谁改的都查得到。
  // ⚠️ 前端 CommissionTab 的 canEdit 必须同步放开——只改后端会让页面仍渲染只读态，
  //    使用者看到的就是「没有权限」（立减规则那次已经踩过这个半提交陷阱）。
  app.put(
    '/:id/commission-rules',
    { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = putCommissionRulesBodySchema.parse(req.body);
      const agent = await prisma.agent.findUnique({
        where: { id },
        select: { id: true, companyName: true, contactName: true },
      });
      if (!agent) throw new NotFoundError('代理不存在');

      // 生效日：省略 body.effectiveFrom → 此刻生效（原行为）；传入 'YYYY-MM-DD' → 该日**上海零点**。
      // 用上海而非 UTC：财务口径「9 月 1 日起飞开始算返佣」说的是北京时间的 9/1。
      // ⚠️ 关键不变式：此锚点必须与计提侧 createCommissionsForOrder 构造出发日窗口的锚点一致
      //   （那边同样 localToUtc(出发日,'00:00',BUSINESS_TZ)）。两边一致时比较等价于纯日期字符串
      //   比较；任一边改回 UTC 零点，北京时间凌晨 0–8 点起飞的航班就会被系统性算成前一天。
      const effectiveFrom = body.effectiveFrom
        ? localToUtc(body.effectiveFrom, '00:00', BUSINESS_TZ)
        : new Date();
      const entries = Object.entries(body.rates) as Array<[keyof typeof body.rates, number]>;
      const written: Record<string, number> = {};
      for (const [kind, rate] of entries) {
        // 追加新规则（同 agent+kind+effectiveFrom 唯一；同一生效日重复提交由唯一约束兜底 upsert，
        // 即改同一天的费率会更新那条，不会重复建行）
        await prisma.commissionRule.upsert({
          where: {
            agentId_productKind_effectiveFrom: {
              agentId: id,
              productKind: kind as ProductKind,
              effectiveFrom,
            },
          },
          update: { rate: new Prisma.Decimal(rate) },
          create: {
            agentId: id,
            productKind: kind as ProductKind,
            rate: new Prisma.Decimal(rate),
            effectiveFrom,
          },
        });
        written[kind] = rate;
      }
      void writeAudit({
        actor: actorFromRequest(req),
        action: 'SET_COMMISSION_RULES',
        targetType: 'AGENT',
        targetId: id,
        targetLabel: agent.companyName ?? agent.contactName,
        after: { rates: written, effectiveFrom: effectiveFrom.toISOString() },
        severity: 'WARNING', // 动费率=动钱，留痕等级同停用
      });
      return { ok: true, rates: written, effectiveFrom: effectiveFrom.toISOString() };
    },
  );
};
