/**
 * 收款对账台 / 挂账池路由（ADMIN/STAFF）。
 *
 * 注册前缀 /receipts：
 *   GET  /receipts?status=&q=     挂账池列表（含 remaining + 认领明细）
 *   GET  /receipts/ledger         总账（合并 Receipts + 近期订单 Payments）
 *   POST /receipts                登记新进账（OPEN）
 *   POST /receipts/:id/allocate   认领到订单（原子）
 *   POST /receipts/:id/refund     退款剩余未认领部分
 *   POST /receipts/statement/parse    解析二维码流水 xlsx（预览，不写库）
 *   POST /receipts/statement/import   流水入池（externalTxnId 唯一去重）
 *   GET  /receipts/statement/export   流水核对表 xlsx（含认款标识）
 *   GET  /receipts/match-candidates   认款工作台：待收款订单候选
 *
 * 审计在 service 层按资金口径写（REGISTER/ALLOCATE/REFUND_RECEIPT/IMPORT_RECEIPT_STATEMENT）。
 */
import type { FastifyPluginAsync } from 'fastify';
import { UserRole } from '@prisma/client';
import { ReceiptsService } from './receipts.service.js';
import { BadRequestError } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import {
  allocateReceiptSchema,
  exportStatementQuerySchema,
  importStatementSchema,
  listReceiptsQuerySchema,
  parseStatementSchema,
  refundReceiptSchema,
  registerReceiptSchema,
} from './receipts.schemas.js';
import { statementExportFilename, statementPlatformFileError } from './receipts.statement.js';

export const receiptRoutes: FastifyPluginAsync = async (app) => {
  const service = new ReceiptsService();
  const requireAdminOrStaff = app.requireRole(UserRole.ADMIN, UserRole.STAFF);

  // ── 挂账池列表 ───────────────────────────────────────
  app.get('/', { preHandler: [app.authenticate, requireAdminOrStaff] }, async (req) => {
    const query = listReceiptsQuerySchema.parse(req.query);
    const receipts = await service.list(query);
    return { receipts };
  });

  // ── 总账（合并时间线，只读） ──────────────────────────
  app.get('/ledger', { preHandler: [app.authenticate, requireAdminOrStaff] }, async () => {
    return service.ledger();
  });

  // ── 登记新进账 ───────────────────────────────────────
  app.post('/', { preHandler: [app.authenticate, requireAdminOrStaff] }, async (req, reply) => {
    const body = registerReceiptSchema.parse(req.body);
    const receipt = await service.register(body, { userId: req.user.sub, role: req.user.role });
    return reply.status(201).send({ receipt });
  });

  // ── 认领到订单（原子） ───────────────────────────────
  app.post('/:id/allocate', { preHandler: [app.authenticate, requireAdminOrStaff] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = allocateReceiptSchema.parse(req.body);
    return service.allocate(id, body, { userId: req.user.sub, role: req.user.role });
  });

  // ── 退款剩余未认领部分 ───────────────────────────────
  app.post('/:id/refund', { preHandler: [app.authenticate, requireAdminOrStaff] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = refundReceiptSchema.parse(req.body);
    return service.refund(id, body.note, { userId: req.user.sub, role: req.user.role });
  });

  // ── 二维码流水解析（预览，不写库）─────────────────────
  // bodyLimit 放宽到 16MB（base64 xlsx；与名单解析同款放宽方式）
  app.post(
    '/statement/parse',
    {
      preHandler: [app.authenticate, requireAdminOrStaff],
      bodyLimit: 16 * 1024 * 1024,
    },
    async (req) => {
      const body = parseStatementSchema.parse(req.body);
      try {
        return await service.previewStatement(body.fileBase64, body.platform);
      } catch (e: unknown) {
        // ExcelJS 对损坏/非 xlsx 文件抛底层错 → 统一转 400（与名单解析同口径）
        if (e instanceof BadRequestError) throw e;
        throw new BadRequestError(`流水文件解析失败：${statementPlatformFileError(body.platform)}`);
      }
    },
  );

  // ── 二维码流水入池（externalTxnId 唯一索引兜底去重）───
  app.post(
    '/statement/import',
    { preHandler: [app.authenticate, requireAdminOrStaff] },
    async (req, reply) => {
      const body = importStatementSchema.parse(req.body);
      const result = await service.importStatement(body, {
        userId: req.user.sub,
        role: req.user.role,
      });
      return reply.status(201).send(result);
    },
  );

  // ── 流水核对表导出（xlsx，含认款标识）─────────────────
  app.get(
    '/statement/export',
    { preHandler: [app.authenticate, requireAdminOrStaff] },
    async (req, reply) => {
      const query = exportStatementQuerySchema.parse(req.query);
      const wb = await service.exportStatement(query);
      const buf = await wb.xlsx.writeBuffer();
      void writeAudit({
        actor: { userId: req.user.sub, role: req.user.role },
        action: 'EXPORT_RECEIPT_STATEMENT',
        targetType: 'SYSTEM',
        targetId: 'receipt-statement-export',
        targetLabel: '流水核对表导出',
        after: { from: query.from ?? null, to: query.to ?? null },
      });
      return reply
        .header(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        .header(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(statementExportFilename())}"`,
        )
        .send(Buffer.from(buf as ArrayBuffer));
    },
  );

  // ── 认款工作台：待收款订单候选 ────────────────────────
  app.get(
    '/match-candidates',
    { preHandler: [app.authenticate, requireAdminOrStaff] },
    async () => {
      const orders = await service.matchCandidates();
      return { orders };
    },
  );
};
