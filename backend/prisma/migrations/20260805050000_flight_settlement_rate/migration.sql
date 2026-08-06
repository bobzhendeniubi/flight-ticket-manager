-- 机票结算价日历：运营按「航班号 × 出发日期」维护每人同业结算价（CNY）。
-- 对应运营的机票报价表（行=日期，列=去/回程航班）；代理下纯机票单时按航段班次自动取价。

-- CreateTable
CREATE TABLE "FlightSettlementRate" (
    "id" TEXT NOT NULL,
    "flightNumber" TEXT NOT NULL,
    "departDate" DATE NOT NULL,
    "pricePerPersonCny" INTEGER NOT NULL,
    "note" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlightSettlementRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex：同一 (航班号, 出发日期) 唯一一个每人价（批量 upsert 幂等键）
CREATE UNIQUE INDEX "FlightSettlementRate_flightNumber_departDate_key" ON "FlightSettlementRate"("flightNumber", "departDate");

-- CreateIndex：按出发日期区间查月度网格
CREATE INDEX "FlightSettlementRate_departDate_idx" ON "FlightSettlementRate"("departDate");
