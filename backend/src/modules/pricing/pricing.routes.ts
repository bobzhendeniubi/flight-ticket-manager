/**
 * 定价管理 — 日期等级 CRUD（ADMIN/STAFF）
 *
 * 公开查询走 /flights/price（见 flights.routes.ts）。
 * 本文件仅管理 DateRanking 表（batch list + override single day + reset to default）。
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AuditSeverity, AuditTargetType, UserRole } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { BadRequestError, NotFoundError } from '../../lib/errors.js';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';

// ── DOW 默认（与 seed 保持一致） ────────────────────────────────
const DOW_RANK: Record<number, string> = {
  0: 'A', // Sunday
  1: 'C', // Monday
  2: 'D', // Tuesday
  3: 'D', // Wednesday
  4: 'C', // Thursday
  5: 'B', // Friday
  6: 'B', // Saturday
};
const DOW_REASON: Record<number, string> = {
  0: 'default:Sunday', 1: 'default:Monday', 2: 'default:Tuesday',
  3: 'default:Wednesday', 4: 'default:Thursday', 5: 'default:Friday', 6: 'default:Saturday',
};

// ── Schemas ────────────────────────────────────────────────────
const listQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
});

const updateRankBodySchema = z.object({
  rank: z.enum(['A', 'B', 'C', 'D']),
  reason: z.string().max(200).optional(),
});

const dateParamSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
});

// ── Helper: 严格解析 YYYY-MM-DD 到 UTC midnight ────────────────
// 拒绝 2026-02-31 这种形状合法但日期不存在的值（Date.UTC 会默默 roll over 到 3/3）。
function parseDateUtc(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // 反向校验：如果 Date 被 normalize 过（例如 02-31 → 03-03），拒绝
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    throw new BadRequestError(`无效日期：${iso}`);
  }
  return dt;
}

export const pricingRoutes: FastifyPluginAsync = async (app) => {
  const pre = { preHandler: [app.authenticate, app.requireRole(UserRole.ADMIN, UserRole.STAFF)] };

  /**
   * GET /pricing/date-rankings?from=2026-04-01&to=2026-06-30
   *
   * 返回区间内所有日期的等级 —— DB 有记录用 DB，没有用 DOW 默认。
   * 最多 400 天（防爆 payload）。
   */
  app.get('/date-rankings', pre, async (req) => {
    const q = listQuerySchema.parse(req.query);
    const from = parseDateUtc(q.from);
    const to = parseDateUtc(q.to);
    if (to < from) throw new BadRequestError('to 必须 >= from');
    const dayMs = 86400000;
    const dayCount = Math.round((to.getTime() - from.getTime()) / dayMs) + 1;
    if (dayCount > 400) throw new BadRequestError('区间最多 400 天');

    const rows = await prisma.dateRanking.findMany({
      where: { date: { gte: from, lte: to } },
      orderBy: { date: 'asc' },
    });
    const dbMap = new Map(rows.map((r) => [r.date.toISOString().slice(0, 10), r]));

    const result: Array<{
      date: string;
      rank: string;
      reason: string | null;
      isManual: boolean;
      source: 'db' | 'default';
    }> = [];

    for (let i = 0; i < dayCount; i++) {
      const d = new Date(from.getTime() + i * dayMs);
      const key = d.toISOString().slice(0, 10);
      const hit = dbMap.get(key);
      if (hit) {
        result.push({
          date: key,
          rank: hit.rank,
          reason: hit.reason,
          isManual: hit.isManual,
          source: 'db',
        });
      } else {
        const dow = d.getUTCDay();
        result.push({
          date: key,
          rank: DOW_RANK[dow] ?? 'C',
          reason: DOW_REASON[dow] ?? null,
          isManual: false,
          source: 'default',
        });
      }
    }

    return { rankings: result };
  });

  /**
   * PATCH /pricing/date-rankings/:date   body: { rank, reason? }
   *
   * upsert 单日 override（isManual = true）。
   */
  app.patch('/date-rankings/:date', pre, async (req) => {
    const { date } = dateParamSchema.parse(req.params);
    const body = updateRankBodySchema.parse(req.body);
    const dateUtc = parseDateUtc(date);

    const before = await prisma.dateRanking.findUnique({ where: { date: dateUtc } });

    const saved = await prisma.dateRanking.upsert({
      where: { date: dateUtc },
      create: {
        date: dateUtc,
        rank: body.rank,
        reason: body.reason ?? 'manual override',
        isManual: true,
      },
      update: {
        rank: body.rank,
        reason: body.reason ?? 'manual override',
        isManual: true,
      },
    });

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'OVERRIDE_DATE_RANKING',
      targetType: AuditTargetType.PRICING,
      targetId: saved.id,
      targetLabel: date,
      before: before
        ? { rank: before.rank, reason: before.reason, isManual: before.isManual }
        : null,
      after: { rank: saved.rank, reason: saved.reason, isManual: saved.isManual },
      severity: AuditSeverity.WARNING,
    });

    return { ranking: saved };
  });

  /**
   * DELETE /pricing/date-rankings/:date
   *
   * 删除 DB 行 → 回退到 DOW 默认。
   */
  app.delete('/date-rankings/:date', pre, async (req, reply) => {
    const { date } = dateParamSchema.parse(req.params);
    const dateUtc = parseDateUtc(date);

    const existing = await prisma.dateRanking.findUnique({ where: { date: dateUtc } });
    if (!existing) throw new NotFoundError('该日期没有 override 记录');

    await prisma.dateRanking.delete({ where: { date: dateUtc } });

    void writeAudit({
      actor: actorFromRequest(req),
      action: 'RESET_DATE_RANKING',
      targetType: AuditTargetType.PRICING,
      targetId: existing.id,
      targetLabel: date,
      before: { rank: existing.rank, reason: existing.reason, isManual: existing.isManual },
      after: null,
      severity: AuditSeverity.WARNING,
    });

    void reply;
    return { ok: true };
  });
};
