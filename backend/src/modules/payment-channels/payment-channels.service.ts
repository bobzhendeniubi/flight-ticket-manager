/**
 * 收款渠道服务 —— 统一收款码 / 收款账户 CRUD。
 *
 * 后台（ADMIN/STAFF）维护收款渠道；前台付款页只读「启用中」的渠道。
 * 纯 CRUD，无资金流转，无事务复杂度。
 */
import type { PaymentChannel } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { NotFoundError, BadRequestError } from '../../lib/errors.js';
import type {
  CreatePaymentChannelInput,
  UpdatePaymentChannelInput,
} from './payment-channels.schemas.js';

type PaymentChannelWithAgent = PaymentChannel & {
  agent?: { id: string; companyName: string | null; contactName: string } | null;
};

/** 后台序列化：完整字段（含 isActive / sortOrder / 时间戳 / 专属代理）。 */
export function serializePaymentChannel(c: PaymentChannelWithAgent) {
  return {
    id: c.id,
    kind: c.kind,
    label: c.label,
    qrImageUrl: c.qrImageUrl,
    accountText: c.accountText,
    note: c.note,
    isActive: c.isActive,
    sortOrder: c.sortOrder,
    // 专属代理：null = 公司统一码；非 null = 该代理专属收款码（部分代理有专用收款码）
    agentId: c.agentId,
    agentName: c.agent ? (c.agent.companyName || c.agent.contactName) : null,
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
  /** 后台列表：全部渠道，按 sortOrder、创建时间排序（含专属代理名称）。 */
  async list() {
    const rows = await prisma.paymentChannel.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { agent: { select: { id: true, companyName: true, contactName: true } } },
    });
    return rows.map(serializePaymentChannel);
  }

  /**
   * 前台公开列表：只返回启用中的「公司统一码」（agentId = null）。
   * 代理专属码（agentId != null）不进这条公开路径 —— 避免把某代理的专用收款码
   * 泄露给所有客户；专属码只通过 /agent-recharges/my-channels（登录代理本人）读取。
   */
  async listActivePublic() {
    const rows = await prisma.paymentChannel.findMany({
      where: { isActive: true, agentId: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(serializePublicPaymentChannel);
  }

  /** 校验 agentId 存在（不存在 → 400，防止绑定到一个不存在的代理）。 */
  private async assertAgentExists(agentId: string): Promise<void> {
    const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } });
    if (!agent) throw new BadRequestError('绑定的代理不存在');
  }

  async create(input: CreatePaymentChannelInput) {
    if (input.agentId) await this.assertAgentExists(input.agentId);
    const created = await prisma.paymentChannel.create({
      data: {
        kind: input.kind,
        label: input.label,
        qrImageUrl: input.qrImageUrl ?? null,
        accountText: input.accountText ?? null,
        note: input.note ?? null,
        isActive: input.isActive ?? true,
        sortOrder: input.sortOrder ?? 0,
        agentId: input.agentId ?? null,
      },
      include: { agent: { select: { id: true, companyName: true, contactName: true } } },
    });
    return serializePaymentChannel(created);
  }

  async update(id: string, input: UpdatePaymentChannelInput) {
    const existing = await prisma.paymentChannel.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('收款渠道不存在');
    if (input.agentId) await this.assertAgentExists(input.agentId);
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
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      },
      include: { agent: { select: { id: true, companyName: true, contactName: true } } },
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
