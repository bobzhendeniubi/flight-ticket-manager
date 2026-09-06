/**
 * 供应商主数据 —— 应付账的抬头。
 *
 * 只做四件事：列、建、改、挂产品。**不碰任何成本口径**：毛利仍旧由各产品自己的成本字段
 * （FlightCostPeriod / HotelRoomType.costPriceCny / Visa.costPriceCny / 签证任务级成本）
 * 算出来，本模块一个字都不改。这里回答的是另一个问题 —— 「这笔钱是付给谁的」。
 *
 * 停用（isActive=false）而不是删除：账单挂着的供应商删了，历史账就成了无主账。
 * 产品外键一律 onDelete: SetNull，也是同一个道理。
 */
import { Prisma, SupplierType, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js';

export const SUPPLIER_TYPE_LABEL: Record<SupplierType, string> = {
  AIRLINE: '航司 / 包机方',
  HOTEL: '酒店 / 地接',
  VISA_AGENCY: '签证公司',
  TRANSFER: '车队 / 地面服务',
  OTHER: '其他',
};

export interface SupplierDto {
  id: string;
  type: SupplierType;
  typeLabel: string;
  name: string;
  currency: string;
  contactName: string | null;
  contactPhone: string | null;
  note: string | null;
  isActive: boolean;
  /** 挂在这家供应商名下的产品条数（酒店 / 签证 / 航班），列表上一眼看出「配没配」 */
  linkedCounts: { hotels: number; visas: number; flights: number };
  createdAt: string;
  updatedAt: string;
}

export interface SupplierWriteInput {
  type: SupplierType;
  name: string;
  currency?: string;
  contactName?: string | null;
  contactPhone?: string | null;
  note?: string | null;
  isActive?: boolean;
}

export type SupplierPatchInput = Partial<SupplierWriteInput>;

type SupplierRow = Prisma.SupplierGetPayload<{
  include: { _count: { select: { hotels: true; visas: true; flights: true } } };
}>;

const WITH_COUNTS = {
  _count: { select: { hotels: true, visas: true, flights: true } },
} satisfies Prisma.SupplierInclude;

function toDto(row: SupplierRow): SupplierDto {
  return {
    id: row.id,
    type: row.type,
    typeLabel: SUPPLIER_TYPE_LABEL[row.type],
    name: row.name,
    currency: row.currency,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    note: row.note,
    isActive: row.isActive,
    linkedCounts: {
      hotels: row._count.hotels,
      visas: row._count.visas,
      flights: row._count.flights,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ListSuppliersFilter {
  type?: SupplierType;
  /** true=只看启用，false=只看停用，缺省=全部 */
  isActive?: boolean;
  /** 名称模糊搜索 */
  q?: string;
}

export async function listSuppliers(
  filter: ListSuppliersFilter = {},
  client: PrismaClient = defaultPrisma,
): Promise<SupplierDto[]> {
  const rows = await client.supplier.findMany({
    where: {
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.isActive === undefined ? {} : { isActive: filter.isActive }),
      ...(filter.q ? { name: { contains: filter.q, mode: 'insensitive' as const } } : {}),
    },
    include: WITH_COUNTS,
    // 启用的排前面，其次按类型、名称 —— 停用的沉底但不隐藏（历史账要点得进去）
    orderBy: [{ isActive: 'desc' }, { type: 'asc' }, { name: 'asc' }],
  });
  return rows.map(toDto);
}

export async function getSupplier(
  id: string,
  client: PrismaClient = defaultPrisma,
): Promise<SupplierDto> {
  const row = await client.supplier.findUnique({ where: { id }, include: WITH_COUNTS });
  if (!row) throw new NotFoundError('供应商不存在');
  return toDto(row);
}

/** 币种规范化：统一大写三位。空/未填 → CNY（绝大多数供应商就是人民币结算）。 */
export function normalizeCurrency(input: string | undefined | null): string {
  const c = (input ?? 'CNY').trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(c)) throw new BadRequestError('币种须为 3 位大写代码，如 CNY / USD');
  return c;
}

export async function createSupplier(
  input: SupplierWriteInput,
  client: PrismaClient = defaultPrisma,
): Promise<SupplierDto> {
  const name = input.name.trim();
  if (!name) throw new BadRequestError('供应商名称不能为空');
  try {
    const row = await client.supplier.create({
      data: {
        type: input.type,
        name,
        currency: normalizeCurrency(input.currency),
        contactName: input.contactName?.trim() || null,
        contactPhone: input.contactPhone?.trim() || null,
        note: input.note?.trim() || null,
        isActive: input.isActive ?? true,
      },
      include: WITH_COUNTS,
    });
    return toDto(row);
  } catch (e) {
    // 同类型重名：直接告诉运营「已经有一家了」，而不是让它变成第二条影子账
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new ConflictError(`「${SUPPLIER_TYPE_LABEL[input.type]}」下已有同名供应商「${name}」`);
    }
    throw e;
  }
}

export async function updateSupplier(
  id: string,
  patch: SupplierPatchInput,
  client: PrismaClient = defaultPrisma,
): Promise<SupplierDto> {
  const existing = await client.supplier.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new NotFoundError('供应商不存在');

  const name = patch.name === undefined ? undefined : patch.name.trim();
  if (name !== undefined && !name) throw new BadRequestError('供应商名称不能为空');

  try {
    const row = await client.supplier.update({
      where: { id },
      data: {
        ...(patch.type === undefined ? {} : { type: patch.type }),
        ...(name === undefined ? {} : { name }),
        ...(patch.currency === undefined ? {} : { currency: normalizeCurrency(patch.currency) }),
        ...(patch.contactName === undefined
          ? {}
          : { contactName: patch.contactName?.trim() || null }),
        ...(patch.contactPhone === undefined
          ? {}
          : { contactPhone: patch.contactPhone?.trim() || null }),
        ...(patch.note === undefined ? {} : { note: patch.note?.trim() || null }),
        ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }),
      },
      include: WITH_COUNTS,
    });
    return toDto(row);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new ConflictError('同类型下已有同名供应商');
    }
    throw e;
  }
}

// ── 产品挂供应商 ─────────────────────────────────────────────────────────────
// 三张产品表各挂一个可空外键。挂 / 解挂都只动这一列，不碰产品的任何其他字段
// —— 尤其不碰成本字段：挂个供应商不该让毛利数字动一分。

export type LinkableProduct = 'hotel' | 'visa' | 'flight';

const PRODUCT_LABEL: Record<LinkableProduct, string> = {
  hotel: '酒店',
  visa: '签证产品',
  flight: '航班',
};

/** 该产品类型允许挂哪些供应商类型 —— 把「酒店挂到航司名下」这种错配挡在写入前。 */
export const ALLOWED_SUPPLIER_TYPES: Record<LinkableProduct, SupplierType[]> = {
  hotel: [SupplierType.HOTEL, SupplierType.OTHER],
  visa: [SupplierType.VISA_AGENCY, SupplierType.OTHER],
  flight: [SupplierType.AIRLINE, SupplierType.OTHER],
};

export async function linkProductSupplier(
  product: LinkableProduct,
  productId: string,
  supplierId: string | null,
  client: PrismaClient = defaultPrisma,
): Promise<{ product: LinkableProduct; productId: string; supplierId: string | null }> {
  if (supplierId) {
    const supplier = await client.supplier.findUnique({
      where: { id: supplierId },
      select: { id: true, type: true, isActive: true },
    });
    if (!supplier) throw new NotFoundError('供应商不存在');
    if (!supplier.isActive) throw new BadRequestError('该供应商已停用，不能再挂新产品');
    if (!ALLOWED_SUPPLIER_TYPES[product].includes(supplier.type)) {
      throw new BadRequestError(
        `${PRODUCT_LABEL[product]}只能挂「${ALLOWED_SUPPLIER_TYPES[product]
          .map((t) => SUPPLIER_TYPE_LABEL[t])
          .join('」或「')}」类型的供应商`,
      );
    }
  }

  const data = { supplierId };
  try {
    if (product === 'hotel') await client.hotel.update({ where: { id: productId }, data });
    else if (product === 'visa') await client.visa.update({ where: { id: productId }, data });
    else await client.flight.update({ where: { id: productId }, data });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      throw new NotFoundError(`${PRODUCT_LABEL[product]}不存在`);
    }
    throw e;
  }
  return { product, productId, supplierId };
}
