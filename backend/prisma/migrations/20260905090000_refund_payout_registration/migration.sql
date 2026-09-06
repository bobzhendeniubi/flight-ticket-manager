-- Refund 实付登记 —— 「已核准」与「钱真的打出去了」拆成两件事。
--
-- 背景：退款走到 status=COMPLETED 就停在那里了。COMPLETED 的含义是「已核准、订单侧已按退款
-- 口径扣减已收净额」，但真正把钱退给客人是财务在银行/微信里的手工动作，系统里零痕迹。
-- 于是两类事故都查不出来：核准了一直没打（客人来催才发现）、以及同一笔退款打了两次。
--
-- 五列全部可空、无默认值、不回填：paidAt IS NULL 即「尚未打款」，存量退款天然落进待打款队列，
-- 由财务逐笔核对后补登记。绝不参与任何金额口径 —— 已收净额照旧只认 status=COMPLETED
--（见 backend/src/lib/net-received.ts），退款状态机一个字不改。
-- 回滚只需 DROP COLUMN + DROP INDEX，不涉及数据变更。

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3);
ALTER TABLE "Refund" ADD COLUMN IF NOT EXISTS "paidMethod" TEXT;
ALTER TABLE "Refund" ADD COLUMN IF NOT EXISTS "paidTxnRef" TEXT;
ALTER TABLE "Refund" ADD COLUMN IF NOT EXISTS "paidByUserId" TEXT;
ALTER TABLE "Refund" ADD COLUMN IF NOT EXISTS "paidNote" TEXT;

-- CreateIndex：待打款队列热路径（status=COMPLETED AND "paidAt" IS NULL，再按 processedAt 排账龄）
CREATE INDEX IF NOT EXISTS "Refund_status_paidAt_idx" ON "Refund"("status", "paidAt");
