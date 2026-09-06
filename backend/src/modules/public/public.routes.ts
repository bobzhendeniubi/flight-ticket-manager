/**
 * 前台公开（免登录）路由 —— 统一收款码展示 + 客户上传付款凭证 + 航线/机场/酒店城市聚合。
 *
 * 注册前缀 /public：
 *   GET  /public/payment-channels      只读「启用中」收款渠道（id, kind, label, qrImageUrl, accountText, note）
 *   POST /public/orders/upload-receipt 客户上传付款凭证（仅声明，进挂账池，不给订单加钱）
 *   GET  /public/routes                活跃航班 distinct 航线（起降机场对 + 展示信息 + 时区）
 *   GET  /public/airports              出现在活跃航班里的机场清单
 *   GET  /public/hotel-cities          在架酒店 distinct 城市码 + 中文名
 *
 * 门禁：上传走与公开订单查询完全一致的 orderNo + lookupKey 匹配 + 同等限流 + 6MB 上限。
 * lookupKey 任一命中：手机号 / 邮箱 / 订单联系人姓氏。命中失败一律 404（不泄露哪个字段错）。
 * 后三个聚合端点为只读展示数据（不含库存/价格），与 payment-channels 同级公开权限。
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { PaymentMethod } from '@prisma/client';
import { OrderService } from '../orders/orders.service.js';
import { PaymentChannelsService } from '../payment-channels/payment-channels.service.js';
import { ReceiptsService } from '../receipts/receipts.service.js';
import { dataUrlImageSchema } from '../../lib/proof-url.js';
import { listPublicAirports, listPublicHotelCities, listPublicRoutes } from './public.service.js';

const uploadReceiptBodySchema = z.object({
  orderNo: z.string().min(3).max(40),
  // 与公开查单同口径的门禁键：手机号 / 邮箱 / 姓氏 任一。
  // 至少 2 字符：单字符的姓氏猜测空间太小，提高公开上传的第二因子强度。
  lookupKey: z.string().min(2).max(120),
  // 上传金额（可选；缺省用订单应付尾款）
  amountCny: z.number().positive().max(100_000_000).optional(),
  method: z.nativeEnum(PaymentMethod).optional(),
  // 付款凭证截图（必填）：≤6MB + 必须是 data:image/...;base64 的 data-URL。
  // 客户来源不可信：强制 data-URL 图片，挡住 data:text/html / 外链等 XSS 注入向量。
  proofUrl: dataUrlImageSchema,
});

export const publicRoutes: FastifyPluginAsync = async (app) => {
  const channelsService = new PaymentChannelsService();
  const ordersService = new OrderService();
  const receiptsService = new ReceiptsService();

  // ── 启用中收款渠道（公开只读） ───────────────────────
  app.get('/payment-channels', async () => {
    const channels = await channelsService.listActivePublic();
    return { channels };
  });

  // ── 活跃航线 / 机场 / 酒店城市聚合（公开只读，前端据此动态渲染，不再写死目的地）──
  app.get('/routes', async () => {
    const routes = await listPublicRoutes();
    return { routes };
  });

  app.get('/airports', async () => {
    const airports = await listPublicAirports();
    return { airports };
  });

  app.get('/hotel-cities', async () => {
    const cities = await listPublicHotelCities();
    return { cities };
  });

  // ── 客户上传付款凭证（公开，门禁 + 限流 + 6MB） ───────
  app.post(
    '/orders/upload-receipt',
    {
      config: {
        // 与公开订单查询一致的更严限流（~10 req/min/IP）防枚举订单号
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const body = uploadReceiptBodySchema.parse(req.body);

      // 门禁：orderNo + lookupKey 必须命中（不命中一律 404，不区分哪个字段错）
      const match = await ordersService.lookupOrderForReceiptUpload(body.orderNo, body.lookupKey);
      if (!match) {
        return reply.status(404).send({ error: '未找到匹配的订单，请核对订单号与联系方式' });
      }

      // 金额缺省用订单应付尾款；尾款 ≤ 0（已结清）时退回让客户填具体金额
      const amountCny = body.amountCny ?? match.balanceCny;
      if (!(amountCny > 0)) {
        return reply
          .status(400)
          .send({ error: '请填写本次付款金额' });
      }

      const result = await receiptsService.customerUpload({
        orderId: match.orderId,
        amountCny,
        method: body.method ?? PaymentMethod.WECHAT_PAY,
        proofUrl: body.proofUrl,
        payerNote: `客户上传 ${body.orderNo}`,
      });

      return reply.status(201).send(result);
    },
  );
};
