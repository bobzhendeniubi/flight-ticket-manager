/**
 * 代理对账单路由（挂在 /agents 前缀下，与 agents.routes.ts 并列注册）
 *
 *   GET /agents/:id/statement?month=YYYY-MM[&format=xlsx]
 *     JSON（默认）或 xlsx。RBAC：AGENT 只能取自己或下级（resolveStatementScope 判），
 *     ADMIN/STAFF 任意，CUSTOMER 一律 403。
 *
 * 为什么不塞进 agents.routes.ts：那个文件已经装着代理 CRUD + 佣金费率两摊事，
 * 对账单自带服务层与导出层，单独一个路由文件更好找也更好改（同 /orders 前缀下并列
 * 挂着 orders / reviews / settlement-requests 等多个插件的既有做法）。
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import { businessDateISO } from '../../lib/business-time.js';
import {
  buildAgentStatement,
  resolveStatementScope,
  type AgentStatementRequester,
} from './agent-statements.service.js';
import { agentStatementFilename, buildAgentStatementWorkbook } from './agent-statements.export.js';

const statementQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/u, '月份格式应为 YYYY-MM')
    .optional(),
  format: z.enum(['json', 'xlsx']).optional(),
});

/** 缺省月份 = 当前**业务月**（北京时间），与页面上「本月」的直觉一致。 */
function currentBusinessMonth(): string {
  return businessDateISO(new Date()).slice(0, 7);
}

export const agentStatementRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:id/statement', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = statementQuerySchema.parse(req.query ?? {});
    const month = query.month ?? currentBusinessMonth();

    const requester = await buildRequester(req.user.sub, req.user.role);
    const scopeAgentIds = await resolveStatementScope(id, requester);
    const statement = await buildAgentStatement({ agentId: id, month, scopeAgentIds }, prisma);

    // 留痕：对账单含金额与佣金，谁在什么时候把哪家的账拉走了要查得到（口径同财务页 VIEW_FINANCES）。
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'VIEW_AGENT_STATEMENT',
      targetType: 'AGENT',
      targetId: id,
      targetLabel: statement.agent.companyName ?? statement.agent.contactName,
      after: { month, format: query.format ?? 'json', orderCount: statement.rows.length },
    });

    if (query.format !== 'xlsx') return { statement };

    const buf = await buildAgentStatementWorkbook(statement);
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(agentStatementFilename(statement))}"`,
      )
      .send(buf);
  });
};

/** 与 settlements.routes.ts 同款：AGENT 角色时把登录账号解析成自己的 agentId。 */
async function buildRequester(userId: string, role: UserRole): Promise<AgentStatementRequester> {
  let agentId: string | undefined;
  if (role === UserRole.AGENT) {
    const agent = await prisma.agent.findUnique({ where: { userId }, select: { id: true } });
    agentId = agent?.id;
  }
  return { userId, role, agentId };
}
