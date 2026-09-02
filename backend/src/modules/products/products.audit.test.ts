import { describe, expect, it } from 'vitest';
import { AuditSeverity } from '@prisma/client';
import {
  bundleAuditSnapshot,
  hotelAuditSnapshot,
  productAuditSeverity,
  transferAuditSnapshot,
  visaAuditSnapshot,
} from './products.audit.js';

describe('产品审计快照', () => {
  it('酒店只保留业务关键字段，并保留房型成本字段', () => {
    expect(
      hotelAuditSnapshot({
        id: 'hotel-1',
        name: '海景酒店',
        starRating: 4,
        intlFiveStar: false,
        isActive: true,
        designationSurchargeCnyPerPerson: 80,
        roomTypes: [{ id: 'room-1', name: '标准房', basePrice: '500', costPriceCny: '350', capacity: 2 }],
        createdAt: 'ignored',
      }),
    ).toEqual({
      name: '海景酒店',
      starRating: 4,
      intlFiveStar: false,
      isActive: true,
      designationSurchargeCnyPerPerson: 80,
      roomTypes: [{ id: 'room-1', name: '标准房', basePrice: '500', costPriceCny: '350' }],
    });
  });

  it('接送/签证使用统一的 price 关键字段，套餐 items 只留摘要', () => {
    expect(transferAuditSnapshot({ name: '机场接送', isActive: true, basePrice: '188', costPriceCny: '65' })).toEqual({
      name: '机场接送',
      isActive: true,
      price: '188',
      costPriceCny: '65',
    });
    expect(visaAuditSnapshot({ visaName: '电子签证', isActive: true, basePrice: '280', costPriceCny: null })).toEqual({
      name: '电子签证',
      isActive: true,
      price: '280',
      costPriceCny: null,
    });
    expect(
      bundleAuditSnapshot({
        name: '海岛套餐',
        isActive: true,
        hotelRoomTypeId: 'room-1',
        hotelRoomType: { hotelName: '海景酒店' },
        discountPct: 10,
        items: [
          { kind: 'HOTEL', productName: '标准房', unitPrice: 500 },
          { kind: 'TRANSFER', productName: '接机', transferId: 'transfer-1', unitPrice: 188 },
        ],
      }),
    ).toEqual({
      name: '海岛套餐',
      isActive: true,
      hotelRoomTypeId: 'room-1',
      hotelName: '海景酒店',
      discountPct: 10,
      items: [
        { kind: 'HOTEL', productName: '标准房', productId: 'room-1' },
        { kind: 'TRANSFER', productName: '接机', productId: 'transfer-1' },
      ],
    });
  });
});

describe('产品审计风险级别', () => {
  it('酒店 PATCH 从上架改为下架 → WARNING', () => {
    expect(
      productAuditSeverity({
        resource: 'HOTEL',
        operation: 'UPDATE',
        before: { isActive: true },
        after: { isActive: false },
      }),
    ).toBe(AuditSeverity.WARNING);
  });

  it('套餐更换绑定房型 → WARNING；普通更新 → INFO', () => {
    expect(
      productAuditSeverity({
        resource: 'BUNDLE',
        operation: 'UPDATE',
        before: { isActive: true, hotelRoomTypeId: 'room-1' },
        after: { hotelRoomTypeId: 'room-2' },
      }),
    ).toBe(AuditSeverity.WARNING);
    expect(
      productAuditSeverity({
        resource: 'BUNDLE',
        operation: 'UPDATE',
        before: { isActive: true, hotelRoomTypeId: 'room-1' },
        after: { name: '新套餐', isActive: true, hotelRoomTypeId: 'room-1' },
      }),
    ).toBe(AuditSeverity.INFO);
  });
});
