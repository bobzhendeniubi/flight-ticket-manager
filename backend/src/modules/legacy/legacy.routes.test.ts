import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { StaffRole, UserRole } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({ user: { findUnique: vi.fn() } }));
vi.mock('../../db/prisma.js', () => ({ prisma: prismaMock }));

const serviceMock = vi.hoisted(() => ({
  listLegacyTickets: vi.fn(),
  getLegacyTicket: vi.fn(),
  getLegacyPassengerHistory: vi.fn(),
  getLegacyDashboard: vi.fn(),
  getLegacyStats: vi.fn(),
}));
vi.mock('./legacy.service.js', () => serviceMock);

import { authPlugin } from '../../plugins/auth.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { legacyRoutes } from './legacy.routes.js';

describe('历史档案权限与查询接口', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(authPlugin);
    registerErrorHandler(app);
    await app.register(legacyRoutes, { prefix: '/legacy' });
    await app.ready();
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      authVersion: 0,
      mustChangePassword: false,
      agentProfile: null,
      staffRole: StaffRole.TICKETING,
    });
    serviceMock.listLegacyTickets.mockResolvedValue({ items: [], pagination: { page: 1, pageSize: 20, total: 0 } });
    serviceMock.getLegacyPassengerHistory.mockResolvedValue({ total: 3, superseded: 2, items: [] });
    serviceMock.getLegacyDashboard.mockResolvedValue({
      monthly: [], payment: { confirmed: 0, unconfirmed: 0 },
      totals: { finalPriceSum: '0', truePriceSum: '0', receiptCount: 0, receiptAmountSum: '0' },
      topOrgs: [], topFlights: [], dataIssues: [], superseded: 0,
    });
    serviceMock.getLegacyStats.mockResolvedValue({ total: 0, uniquePassengers: 0, receiptCount: 0, superseded: 0, dateFrom: null, dateTo: null });
  });

  function tokenFor(sub: string, role: UserRole): string {
    return app.jwt.sign({ sub, role });
  }

  it('拒绝 AGENT，所有 STAFF 岗位均可访问', async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      disabledAt: null,
      authVersion: 0,
      mustChangePassword: false,
      agentProfile: { isActive: true },
      staffRole: null,
    });
    const agent = await app.inject({
      method: 'GET',
      url: '/legacy/tickets',
      headers: { authorization: `Bearer ${tokenFor('agent-1', UserRole.AGENT)}` },
    });
    expect(agent.statusCode).toBe(403);

    const dashboardAgent = await app.inject({
      method: 'GET',
      url: '/legacy/dashboard',
      headers: { authorization: `Bearer ${tokenFor('agent-1', UserRole.AGENT)}` },
    });
    expect(dashboardAgent.statusCode).toBe(403);

    for (const staffRole of Object.values(StaffRole)) {
      prismaMock.user.findUnique.mockResolvedValue({
        disabledAt: null,
        authVersion: 0,
        mustChangePassword: false,
        agentProfile: null,
        staffRole,
      });
      const response = await app.inject({
        method: 'GET',
        url: '/legacy/tickets',
        headers: { authorization: `Bearer ${tokenFor(`staff-${staffRole}`, UserRole.STAFF)}` },
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it('passes search, date, payment, deletion, and pagination filters to the service', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/legacy/tickets?q=PX-1&dateFrom=2026-08-01&dateTo=2026-08-24&orgId=org-a&paymentConfirmed=false&dataIssue=birth%3Aafter-order&includeDeleted=true&page=2&pageSize=50',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
    });
    expect(response.statusCode).toBe(200);
    expect(serviceMock.listLegacyTickets).toHaveBeenCalledWith({
      q: 'PX-1', dateFrom: '2026-08-01', dateTo: '2026-08-24', orgId: 'org-a',
      paymentConfirmed: false, dataIssue: 'birth:after-order', includeDeleted: true, page: 2, pageSize: 50,
    });

    await app.inject({
      method: 'GET',
      url: '/legacy/tickets',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
    });
    expect(serviceMock.listLegacyTickets).toHaveBeenLastCalledWith({
      includeDeleted: false, page: 1, pageSize: 20,
    });
  });

  it('returns passenger history with superseded count for the order badge', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/legacy/passenger-history?doc=px-1',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
    });
    expect(response.statusCode).toBe(200);
    expect(serviceMock.getLegacyPassengerHistory).toHaveBeenCalledWith('px-1');
    expect(response.json()).toEqual({ total: 3, superseded: 2, items: [] });
  });

  it('allows staff to load the dashboard', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/legacy/dashboard',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
    });
    expect(response.statusCode).toBe(200);
    expect(serviceMock.getLegacyDashboard).toHaveBeenCalledOnce();
  });

  it('rejects dates that are not real calendar dates', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/legacy/tickets?dateFrom=2026-02-31',
      headers: { authorization: `Bearer ${tokenFor('staff-1', UserRole.STAFF)}` },
    });
    expect(response.statusCode).toBe(400);
    expect(serviceMock.listLegacyTickets).not.toHaveBeenCalled();
  });
});
