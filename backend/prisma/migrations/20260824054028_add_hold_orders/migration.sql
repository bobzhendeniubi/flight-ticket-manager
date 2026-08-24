-- 占位单（无名单库存实体）：占座但尚未形成正式乘客订单。
-- 可售余量 = capacity − sold − 未过期 ACTIVE 锁位 − 占位余座。

-- CreateEnum
CREATE TYPE "HoldOrderStatus" AS ENUM ('PENDING', 'HOLDING', 'OVERDUE', 'FULLY_PAID', 'CONVERTED', 'RELEASED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HoldOwnerType" AS ENUM ('AGENT', 'CUSTOMER');

-- CreateTable
CREATE TABLE "HoldOrder" (
    "id" TEXT NOT NULL,
    "holdNo" TEXT NOT NULL,
    "flightScheduleId" TEXT NOT NULL,
    "seatClassId" TEXT NOT NULL,
    "ownerType" "HoldOwnerType" NOT NULL,
    "agentId" TEXT,
    "groupName" TEXT,
    "seats" INTEGER NOT NULL,
    "seatsConverted" INTEGER NOT NULL DEFAULT 0,
    "seatsCancelled" INTEGER NOT NULL DEFAULT 0,
    "perSeatPriceCny" INTEGER NOT NULL,
    "freeCancelRatio" DECIMAL(4,3),
    "freeCancelUsed" INTEGER NOT NULL DEFAULT 0,
    "status" "HoldOrderStatus" NOT NULL DEFAULT 'HOLDING',
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HoldOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HoldOrder_holdNo_key" ON "HoldOrder"("holdNo");

-- CreateIndex
CREATE INDEX "HoldOrder_seatClassId_status_idx" ON "HoldOrder"("seatClassId", "status");

-- CreateIndex
CREATE INDEX "HoldOrder_flightScheduleId_status_idx" ON "HoldOrder"("flightScheduleId", "status");

-- CreateIndex
CREATE INDEX "HoldOrder_agentId_status_idx" ON "HoldOrder"("agentId", "status");

-- AddForeignKey
ALTER TABLE "HoldOrder" ADD CONSTRAINT "HoldOrder_flightScheduleId_fkey" FOREIGN KEY ("flightScheduleId") REFERENCES "FlightSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HoldOrder" ADD CONSTRAINT "HoldOrder_seatClassId_fkey" FOREIGN KEY ("seatClassId") REFERENCES "FlightSeatClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HoldOrder" ADD CONSTRAINT "HoldOrder_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
