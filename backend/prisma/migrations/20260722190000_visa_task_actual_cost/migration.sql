-- AlterTable: 签证任务实际成本（人均口径，仅 VISA_APPLICATION 用）。
-- 三列可空 → 存量任务天然回退产品主数据 Visa.costPriceCny 成本口径，不会被算成 0。
-- CNY 为入账权威：填了 USD+汇率则自动折算 CNY 存底，也允许直接填 CNY。
ALTER TABLE "FulfillmentTask" ADD COLUMN     "visaUnitCostUsd" DECIMAL(10,2),
ADD COLUMN     "visaFxRate" DECIMAL(12,6),
ADD COLUMN     "visaUnitCostCny" DECIMAL(10,2);
