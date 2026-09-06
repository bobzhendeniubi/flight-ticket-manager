/**
 * 供应商主数据路由（挂在 /finances 前缀下，与 financesRoutes 并列注册）
 *
 *   GET   /finances/suppliers            列表（type / isActive / q 过滤）
 *   GET   /finances/suppliers/:id        单个
 *   POST  /finances/suppliers            新建
 *   PATCH /finances/suppliers/:id        改（含停用 isActive=false）
 *   PUT   /finances/suppliers/link       给酒店 / 签证产品 / 航班挂或解挂供应商
 *
 * 闸：与财务页同一道 requireFinanceAccess（ADMIN 或 STAFF+财务岗）。应付账是钱的另一半，
 * 看得到收入毛利的人才该看得到我们欠谁多少。
 *
 * 为什么不塞进 finances.routes.ts：那个文件已经装着损益 / 导出 / 成本周期 / 汇率四摊事，
 * 应付账自带服务层与对账层，单开路由文件更好找也更好改（同 /orders 前缀下并列挂多个插件的既有做法）。
 */
import type { FastifyPluginAsync } from 'fastify';
import { SupplierType } from '@prisma/client';
import { z } from 'zod';
import { actorFromRequest, writeAudit } from '../../lib/audit.js';
import {
  createSupplier,
  getSupplier,
  linkProductSupplier,
  listSuppliers,
  updateSupplier,
} from './suppliers.service.js';

const currencySchema = z.string().regex(/^[A-Za-z]{3}$/u, '币种须为 3 位代码，如 CNY / USD');

const listQuerySchema = z.object({
  type: z.nativeEnum(SupplierType).optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  q: z.string().trim().max(100).optional(),
});

const createBodySchema = z.object({
  type: z.nativeEnum(SupplierType),
  name: z.string().trim().min(1, '供应商名称不能为空').max(120),
  currency: currencySchema.optional(),
  contactName: z.string().trim().max(60).nullable().optional(),
  contactPhone: z.string().trim().max(40).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
});

const patchBodySchema = createBodySchema.partial();

const linkBodySchema = z.object({
  product: z.enum(['hotel', 'visa', 'flight']),
  productId: z.string().min(1),
  /** null = 解挂 */
  supplierId: z.string().min(1).nullable(),
});

export const supplierRoutes: FastifyPluginAsync = async (app) => {
  const requireFinance = { preHandler: [app.authenticate, app.requireFinanceAccess] };

  app.get('/suppliers', requireFinance, async (req) => {
    const q = listQuerySchema.parse(req.query ?? {});
    const suppliers = await listSuppliers(q);
    return { suppliers };
  });

  app.get('/suppliers/:id', requireFinance, async (req) => {
    const { id } = req.params as { id: string };
    return { supplier: await getSupplier(id) };
  });

  app.post('/suppliers', requireFinance, async (req) => {
    const body = createBodySchema.parse(req.body);
    const supplier = await createSupplier(body);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'CREATE_SUPPLIER',
      targetType: 'SYSTEM',
      targetId: supplier.id,
      targetLabel: `${supplier.typeLabel} · ${supplier.name}`,
      after: supplier,
    });
    return { supplier };
  });

  app.patch('/suppliers/:id', requireFinance, async (req) => {
    const { id } = req.params as { id: string };
    const body = patchBodySchema.parse(req.body);
    const before = await getSupplier(id);
    const supplier = await updateSupplier(id, body);
    void writeAudit({
      actor: actorFromRequest(req),
      action: 'UPDATE_SUPPLIER',
      targetType: 'SYSTEM',
      targetId: id,
      targetLabel: `${supplier.typeLabel} · ${supplier.name}`,
      before,
      after: supplier,
    });
    return { supplier };
  });

  /** 给产品挂 / 解挂供应商。只动 supplierId 一列，绝不碰产品的成本或售价字段。 */
  app.put('/suppliers/link', requireFinance, async (req) => {
    const body = linkBodySchema.parse(req.body);
    const result = await linkProductSupplier(body.product, body.productId, body.supplierId);
    void writeAudit({
      actor: actorFromRequest(req),
      action: body.supplierId ? 'LINK_PRODUCT_SUPPLIER' : 'UNLINK_PRODUCT_SUPPLIER',
      targetType: 'PRODUCT',
      targetId: body.productId,
      targetLabel: `${body.product}:${body.productId}`,
      after: result,
    });
    return result;
  });
};
