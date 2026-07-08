-- AlterTable
-- 六态开票（三个独立维度）—— 票务岗需按航段分别开票并导出：
--   outboundInvoiced = 去程已开；returnInvoiced = 回程已开；systemInvoiced = 系统已开。
-- 纯加列，默认 false（未开）；Postgres 直接以默认值回填存量行。
ALTER TABLE "Order" ADD COLUMN "outboundInvoiced" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Order" ADD COLUMN "returnInvoiced" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Order" ADD COLUMN "systemInvoiced" BOOLEAN NOT NULL DEFAULT false;

-- 存量语义迁移：旧的订单级 invoiceStatus=ISSUED 表示「整单已开」——
-- 回填三个布尔全为 true（去程/回程/系统都视为已开），与旧口径一致，不丢历史状态。
UPDATE "Order"
SET "outboundInvoiced" = true,
    "returnInvoiced" = true,
    "systemInvoiced" = true
WHERE "invoiceStatus" = 'ISSUED';
