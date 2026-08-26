-- 到账双状态（业务已收 / 财务已核实）：
--   Payment.verifiedAt / verifiedById       —— 订单收款的财务核实标记
--   Receipt.verifiedAt / verifiedById       —— 运营水单登记（OPS_CLAIM）的财务核实标记
--   ReceiptSource 新增 OPS_CLAIM            —— 占位单手工到账登记的进账来源
-- 存量收款一次性视同已核实（上线前的账都已按旧流程对过，避免把历史数据灌进待核实队列）。

-- AlterEnum
ALTER TYPE "ReceiptSource" ADD VALUE 'OPS_CLAIM';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "verifiedAt" TIMESTAMP(3),
ADD COLUMN "verifiedById" TEXT;

ALTER TABLE "Receipt" ADD COLUMN "verifiedAt" TIMESTAMP(3),
ADD COLUMN "verifiedById" TEXT;

-- CreateIndex
CREATE INDEX "Payment_status_verifiedAt_idx" ON "Payment"("status", "verifiedAt");

-- 存量回填：已入账的收款（含负额处置记录）全部视同已核实；PENDING/FAILED 不动。
UPDATE "Payment" SET "verifiedAt" = COALESCE("paidAt", "createdAt") WHERE "status" = 'SUCCEEDED' AND "verifiedAt" IS NULL;
