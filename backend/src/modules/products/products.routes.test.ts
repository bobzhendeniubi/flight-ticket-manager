import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { UserRole } from '@prisma/client';
import { NotFoundError } from '../../lib/errors.js';

const { serviceMock, actorMock, auditMock } = vi.hoisted(() => ({
  serviceMock: {
    listHotels: vi.fn(),
    getHotel: vi.fn(),
    createHotel: vi.fn(),
    updateHotel: vi.fn(),
    deleteHotel: vi.fn(),
    listTransfers: vi.fn(),
    getTransfer: vi.fn(),
    createTransfer: vi.fn(),
    updateTransfer: vi.fn(),
    deleteTransfer: vi.fn(),
    listVisas: vi.fn(),
    getVisa: vi.fn(),
    createVisa: vi.fn(),
    updateVisa: vi.fn(),
    deleteVisa: vi.fn(),
    listBundles: vi.fn(),
    getBundle: vi.fn(),
    createBundle: vi.fn(),
    updateBundle: vi.fn(),
    deleteBundle: vi.fn(),
    getBundleFlightRef: vi.fn(),
  },
  actorMock: vi.fn(() => ({ userId: 'admin-1', role: UserRole.ADMIN })),
  auditMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/audit.js', () => ({ actorFromRequest: actorMock, writeAudit: auditMock }));
vi.mock('./products.service.js', () => ({ ProductsService: vi.fn(() => serviceMock) }));
vi.mock('./hotel-availability.service.js', () => ({ getHotelAvailability: vi.fn() }));
vi.mock('./bundle-availability.service.js', () => ({ getBundleSellableDates: vi.fn() }));

import { registerErrorHandler } from '../../plugins/error-handler.js';
import { productRoutes } from './products.routes.js';

describe('产品 CRUD 审计路由', () => {
  let app: FastifyInstance;
  const beforeHotel = {
    id: 'hotel-1',
    name: '海景酒店',
    starRating: 4,
    intlFiveStar: false,
    isActive: true,
    designationSurchargeCnyPerPerson: 80,
    roomTypes: [{ id: 'room-1', name: '标准房', basePrice: '500', costPriceCny: '350' }],
    ignoredField: 'not audited',
  };

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.decorate('authenticate', async (req) => {
      req.user = { sub: 'admin-1', role: UserRole.ADMIN };
    });
    app.decorate('optionalAuthenticate', async () => undefined);
    app.decorate('requireRole', (...roles: UserRole[]) => async (req) => {
      if (!roles.includes(req.user.role)) {
        const { ForbiddenError } = await import('../../lib/errors.js');
        throw new ForbiddenError();
      }
    });
    registerErrorHandler(app);
    await app.register(productRoutes, { prefix: '/products' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    serviceMock.getHotel.mockResolvedValue(beforeHotel);
    serviceMock.updateHotel.mockResolvedValue({ ...beforeHotel, isActive: false });
    auditMock.mockResolvedValue(undefined);
  });

  it('PATCH 酒店先读取 before，成功后调用 writeAudit；下架为 WARNING 且 after 是关键字段快照', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/products/hotels/hotel-1',
      payload: { isActive: false, photos: ['https://example.com/new-photo.jpg'] },
    });

    expect(response.statusCode).toBe(200);
    expect(serviceMock.getHotel).toHaveBeenCalledWith('hotel-1', true);
    expect(serviceMock.updateHotel).toHaveBeenCalledWith('hotel-1', {
      isActive: false,
      photos: ['https://example.com/new-photo.jpg'],
    });
    expect(serviceMock.getHotel.mock.invocationCallOrder[0]).toBeLessThan(
      serviceMock.updateHotel.mock.invocationCallOrder[0],
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE_HOTEL',
        targetType: 'PRODUCT',
        targetId: 'hotel-1',
        targetLabel: '海景酒店',
        before: {
          name: '海景酒店',
          starRating: 4,
          intlFiveStar: false,
          isActive: true,
          designationSurchargeCnyPerPerson: 80,
          roomTypes: [{ id: 'room-1', name: '标准房', basePrice: '500', costPriceCny: '350' }],
        },
        after: {
          name: '海景酒店',
          starRating: 4,
          intlFiveStar: false,
          isActive: false,
          designationSurchargeCnyPerPerson: 80,
          roomTypes: [{ id: 'room-1', name: '标准房', basePrice: '500', costPriceCny: '350' }],
        },
        severity: 'WARNING',
      }),
    );
    expect(auditMock.mock.calls[0][0].after).not.toHaveProperty('photos');
  });

  it('PATCH 不存在的酒店 → 404，且不会写审计', async () => {
    serviceMock.getHotel.mockRejectedValueOnce(new NotFoundError('酒店不存在'));

    const response = await app.inject({
      method: 'PATCH',
      url: '/products/hotels/ghost-hotel',
      payload: { name: '新酒店' },
    });

    expect(response.statusCode).toBe(404);
    expect(serviceMock.updateHotel).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('PATCH 套餐更换酒店房型 → after 使用更新后快照且为 WARNING', async () => {
    serviceMock.getBundle.mockResolvedValueOnce({
      id: 'bundle-1',
      name: '海岛套餐',
      isActive: true,
      hotelRoomTypeId: 'room-1',
      items: [],
    });
    serviceMock.updateBundle.mockResolvedValueOnce({
      id: 'bundle-1',
      name: '海岛套餐',
      isActive: true,
      hotelRoomTypeId: 'room-2',
      items: [],
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/products/bundles/bundle-1',
      payload: { hotelRoomTypeId: 'room-2' },
    });

    expect(response.statusCode).toBe(200);
    expect(serviceMock.getBundle.mock.invocationCallOrder[0]).toBeLessThan(
      serviceMock.updateBundle.mock.invocationCallOrder[0],
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE_BUNDLE',
        before: expect.objectContaining({ hotelRoomTypeId: 'room-1' }),
        after: expect.objectContaining({
          name: '海岛套餐',
          isActive: true,
          hotelRoomTypeId: 'room-2',
          items: [],
        }),
        severity: 'WARNING',
      }),
    );
  });
});
