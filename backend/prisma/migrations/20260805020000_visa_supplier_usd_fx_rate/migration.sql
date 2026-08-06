-- 签证岗只想记「签证公司 + 美金金额」，系统自动折人民币入账：
--   1) 签证任务补一列「签证公司」（此前只能塞在备注文本里，财务对账要人肉读）
--   2) 新增全局美金汇率表（按生效日），签证台设金额时自动带出当日汇率

-- AlterTable：本次实际送签的签证公司（产品主数据 Visa.supplier 只是产品默认供应商）
ALTER TABLE "FulfillmentTask" ADD COLUMN     "visaSupplier" TEXT;

-- CreateTable：美金汇率表（按生效日；区间由下一条的生效日隐含 → 无空洞无重叠）
CREATE TABLE "UsdFxRate" (
    "id" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "rate" DECIMAL(12,6) NOT NULL,
    "note" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsdFxRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex：同一生效日唯一一条（upsert 幂等键；同时服务「≤目标日期取最新一条」的倒序扫描）
CREATE UNIQUE INDEX "UsdFxRate_effectiveFrom_key" ON "UsdFxRate"("effectiveFrom");
