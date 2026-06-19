/**
 * 收款渠道服务 —— 统一收款码 / 收款账户 CRUD。
 *
 * 后台（ADMIN/STAFF）维护收款渠道；前台付款页只读「启用中」的渠道。
 * 纯 CRUD，无资金流转，无事务复杂度。
 */
import type { PaymentChannel } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import type {
  CreatePaymentChannelInput,
  UpdatePaymentChannelInput,
} from './payment-channels.schemas.js';

/** 后台序列化：完整字段（含 isActive / sortOrder / 时间戳）。 */
export function serializePaymentChannel(c: PaymentChannel) {
  return {
    id: c.id,
    kind: c.kind,
    label: c.label,
    qrImageUrl: c.qrImageUrl,
    accountText: c.accountText,
    note: c.note,
    isActive: c.isActive,
    sortOrder: c.sortOrder,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** 前台公开序列化：只露展示需要的字段（不含 isActive / 排序 / 时间戳）。 */
export function serializePublicPaymentChannel(c: PaymentChannel) {
  return {
    id: c.id,
    kind: c.kind,
    label: c.label,
    qrImageUrl: c.qrImageUrl,
    accountText: c.accountText,
    note: c.note,
  };
}

export class PaymentChannelsService {
  /** 后台列表：全部渠道，按 sortOrder、创建时间排序。 */
  async list() {
    const rows = await prisma.paymentChannel.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(serializePaymentChannel);
  }

  /** 前台公开列表：只返回启用中的渠道。 */
  async listActivePublic() {
    const rows = await prisma.paymentChannel.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(serializePublicPaymentChannel);
  }

  async create(input: CreatePaymentChannelInput) {
    const created = await prisma.paymentChannel.create({
      data: {
        kind: input.kind,
        label: input.label,
        qrImageUrl: input.qrImageUrl ?? null,
        accountText: input.accountText ?? null,
        note: input.note ?? null,
        isActive: input.isActive ?? true,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    return serializePaymentChannel(created);
  }

  async update(id: string, input: UpdatePaymentChannelInput) {
    const existing = await prisma.paymentChannel.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('收款渠道不存在');
    const updated = await prisma.paymentChannel.update({
      where: { id },
      data: {
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.qrImageUrl !== undefined ? { qrImageUrl: input.qrImageUrl } : {}),
        ...(input.accountText !== undefined ? { accountText: input.accountText } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
    });
    return serializePaymentChannel(updated);
  }

  async remove(id: string) {
    const existing = await prisma.paymentChannel.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('收款渠道不存在');
    await prisma.paymentChannel.delete({ where: { id } });
    return { ok: true as const, id };
  }
}
