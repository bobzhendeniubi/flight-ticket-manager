/**
 * 代理树递归查询工具
 *
 * 使用 PostgreSQL 递归 CTE 一次查完 agent + 所有后代。
 * 单次 round-trip 复杂度 O(树大小)，在代理层级 < 6 时性能充足。
 */
import { prisma } from '../db/prisma.js';

/**
 * 返回代理 agentId 及其所有后代的 id 集合（含自身）。
 * agentId 为空返回空数组。
 */
export async function getDescendantAgentIds(agentId: string | undefined): Promise<string[]> {
  if (!agentId) return [];
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE agent_tree AS (
      SELECT id FROM "Agent" WHERE id = ${agentId}
      UNION ALL
      SELECT a.id FROM "Agent" a
      INNER JOIN agent_tree t ON a."parentAgentId" = t.id
    )
    SELECT id FROM agent_tree
  `;
  return rows.map((r) => r.id);
}
