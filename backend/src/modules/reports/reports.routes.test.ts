import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { StaffRole, UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
}));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const getSalesReportMock = vi.hoisted(() => vi.fn());
vi.mock('./reports.service.js', () => ({
  getAgentDebtsReport: vi.fn(),
  getReceivablesReport: vi.fn(),
  getSalesReport: getSalesReportMock,
}));
vi.mock('./reports.export.js', () => ({
  buildReportsExportWorkbook: vi.fn(),
  reportsExportFilename: vi.fn(() => 'reports.xlsx'),
}));
vi.mock('../../lib/audit.js', () => ({
  actorFromRequest: vi.fn(() => ({ userId: 'test-user', role: UserRole.STAFF })),
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { reportRoutes } from './reports.routes.js';

describe('经营报表财务岗权限', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    registerErrorHandler(app);
    await app.register(reportRoutes, { prefix: '/reports' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function tokenFor(sub: string, role: UserRole): string {
    return app.jwt.sign({ sub, role });
  }

  function setUser(staffRole: StaffRole | null): void {
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      authVersion: 0,
      staffRole,
      agentProfile: null,
    });
  }

  it('STAFF+FINANCE 可以访问销售报表', async () => {
    setUser(StaffRole.FINANCE);
    getSalesReportMock.mockResolvedValue({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: '/reports/sales?from=2026-08-01&to=2026-08-24',
      headers: { authorization: `Bearer ${tokenFor('finance-1', UserRole.STAFF)}` },
    });

    expect(res.statusCode).toBe(200);
    expect(getSalesReportMock).toHaveBeenCalledWith(
      { from: '2026-08-01', to: '2026-08-24' },
      'kind',
    );
  });

  it('STAFF 通用岗位访问销售报表 → 403', async () => {
    setUser(null);

    const res = await app.inject({
      method: 'GET',
      url: '/reports/sales',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
    });

    expect(res.statusCode).toBe(403);
    expect(getSalesReportMock).not.toHaveBeenCalled();
  });
});
