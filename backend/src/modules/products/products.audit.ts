import { AuditSeverity } from '@prisma/client';

type AuditScalar = string | number | boolean | null;
type AuditRecord = Record<string, unknown>;

function scalar(value: unknown): AuditScalar {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

/** 产品审计只保留能解释业务变化的字段，避免把序列化对象或内部无关字段整包落库。 */
export function hotelAuditSnapshot(hotel: AuditRecord): AuditRecord {
  const roomTypes = Array.isArray(hotel.roomTypes) ? hotel.roomTypes : [];
  return {
    name: scalar(hotel.name),
    starRating: scalar(hotel.starRating),
    intlFiveStar: scalar(hotel.intlFiveStar),
    isActive: scalar(hotel.isActive),
    designationSurchargeCnyPerPerson: scalar(hotel.designationSurchargeCnyPerPerson),
    roomTypes: roomTypes.map((roomType) => {
      const rt = (roomType ?? {}) as AuditRecord;
      return {
        id: scalar(rt.id),
        name: scalar(rt.name),
        basePrice: scalar(rt.basePrice),
        costPriceCny: scalar(rt.costPriceCny),
      };
    }),
  };
}

export function transferAuditSnapshot(transfer: AuditRecord): AuditRecord {
  return {
    name: scalar(transfer.name),
    isActive: scalar(transfer.isActive),
    price: scalar(transfer.price ?? transfer.basePrice),
    costPriceCny: scalar(transfer.costPriceCny),
  };
}

export function visaAuditSnapshot(visa: AuditRecord): AuditRecord {
  return {
    name: scalar(visa.name ?? visa.visaName),
    isActive: scalar(visa.isActive),
    price: scalar(visa.price ?? visa.basePrice),
    costPriceCny: scalar(visa.costPriceCny),
  };
}

export function bundleAuditSnapshot(bundle: AuditRecord): AuditRecord {
  const hotelRoomType = (bundle.hotelRoomType ?? {}) as AuditRecord;
  const hotelName = bundle.hotelName ?? hotelRoomType.hotelName ?? (hotelRoomType.hotel as AuditRecord | undefined)?.name;
  const items = Array.isArray(bundle.items) ? bundle.items : [];
  const snapshot: AuditRecord = {
    name: scalar(bundle.name),
    isActive: scalar(bundle.isActive),
    hotelRoomTypeId: scalar(bundle.hotelRoomTypeId),
    items: items.map((item) => {
      const row = (item ?? {}) as AuditRecord;
      const productId = row.productId ?? row.transferId ?? row.visaId ??
        (row.kind === 'HOTEL' ? bundle.hotelRoomTypeId : null);
      return {
        kind: scalar(row.kind),
        productName: scalar(row.productName),
        productId: scalar(productId),
      };
    }),
  };
  if (hotelName !== undefined) snapshot.hotelName = scalar(hotelName);
  if (bundle.discountPct !== undefined) snapshot.discountPct = scalar(bundle.discountPct);
  return snapshot;
}

export type ProductAuditResource = 'HOTEL' | 'TRANSFER' | 'VISA' | 'BUNDLE';
export type ProductAuditOperation = 'CREATE' | 'UPDATE' | 'DELETE';

/** 统一计算产品变更的风险级别，便于路由保持 fire-and-forget 且可单测。 */
export function productAuditSeverity(args: {
  resource: ProductAuditResource;
  operation: ProductAuditOperation;
  before?: unknown;
  after?: unknown;
}): AuditSeverity {
  const before = (args.before ?? {}) as AuditRecord;
  const after = (args.after ?? {}) as AuditRecord;
  const becameInactive = before.isActive === true && after.isActive === false;
  const bundleRoomChanged =
    args.resource === 'BUNDLE' &&
    args.operation === 'UPDATE' &&
    before.hotelRoomTypeId !== after.hotelRoomTypeId;
  const randomHotelName =
    args.resource === 'HOTEL' &&
    ((args.operation === 'CREATE' && typeof after.name === 'string' && after.name.includes('随机')) ||
      (args.operation === 'UPDATE' && typeof after.name === 'string' && after.name.includes('随机')));

  return becameInactive || bundleRoomChanged || randomHotelName
    ? AuditSeverity.WARNING
    : AuditSeverity.INFO;
}
