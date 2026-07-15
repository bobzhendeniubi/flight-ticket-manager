-- 切位（包位）：从散客池划出 N 座给某代理专卖，到期未售回散客池。
-- 散客池余票 = capacity − sold − ACTIVE 未过期锁位 − Σ(ACTIVE 切位 seats)。

-- CreateEnum
CREATE TYPE "SeatAllocationStatus" AS ENUM ('ACTIVE', 'RECLAIMED');

-- CreateTable
CREATE TABLE "SeatAllocation" (
    "id" TEXT NOT NULL,
    "flightScheduleId" TEXT NOT NULL,
    "cabin" "CabinClass" NOT NULL,
    "agentId" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "unitPriceCny" INTEGER,
    "reclaimDaysBefore" INTEGER NOT NULL DEFAULT 7,
    "status" "SeatAllocationStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeatAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeatAllocation_flightScheduleId_cabin_status_idx" ON "SeatAllocation"("flightScheduleId", "cabin", "status");

-- CreateIndex
CREATE INDEX "SeatAllocation_agentId_status_idx" ON "SeatAllocation"("agentId", "status");

-- AddForeignKey
ALTER TABLE "SeatAllocation" ADD CONSTRAINT "SeatAllocation_flightScheduleId_fkey" FOREIGN KEY ("flightScheduleId") REFERENCES "FlightSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatAllocation" ADD CONSTRAINT "SeatAllocation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
