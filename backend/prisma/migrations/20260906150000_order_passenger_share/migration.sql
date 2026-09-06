-- 按人份额落库（审查根因 R1）：纯增量，一张全新表，不回填、无数据迁移。
--
-- 回填走 backend/scripts/backfill-passenger-shares.ts 或 POST /orders/passenger-shares/backfill，
-- 读侧也会对老单 lazy 回填；本迁移本身**不含任何 ALTER TABLE "Order" / "Passenger"**。
-- 回滚：去掉 OrderPassengerShare 这一张表即可，老表无痕。

-- CreateTable
CREATE TABLE "OrderPassengerShare" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "passengerId" TEXT NOT NULL,
    "settlementCny" DECIMAL(12,2) NOT NULL,
    "baseCny" DECIMAL(12,2) NOT NULL,
    "adjustmentCny" DECIMAL(12,2) NOT NULL,
    "visaCny" DECIMAL(12,2) NOT NULL,
    "singleRoomDiffCny" DECIMAL(12,2) NOT NULL,
    "discountCny" DECIMAL(12,2) NOT NULL,
    "algoVersion" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderPassengerShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderPassengerShare_orderId_passengerId_key" ON "OrderPassengerShare"("orderId", "passengerId");

-- CreateIndex
CREATE INDEX "OrderPassengerShare_passengerId_idx" ON "OrderPassengerShare"("passengerId");

-- AddForeignKey
ALTER TABLE "OrderPassengerShare" ADD CONSTRAINT "OrderPassengerShare_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPassengerShare" ADD CONSTRAINT "OrderPassengerShare_passengerId_fkey" FOREIGN KEY ("passengerId") REFERENCES "Passenger"("id") ON DELETE CASCADE ON UPDATE CASCADE;
