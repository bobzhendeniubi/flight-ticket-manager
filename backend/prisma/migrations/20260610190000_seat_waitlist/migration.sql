-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('ACTIVE', 'NOTIFIED', 'FULFILLED', 'CANCELLED');

-- CreateTable
CREATE TABLE "SeatWaitlist" (
    "id" TEXT NOT NULL,
    "flightScheduleId" TEXT NOT NULL,
    "seatClassId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeatWaitlist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeatWaitlist_flightScheduleId_seatClassId_status_idx" ON "SeatWaitlist"("flightScheduleId", "seatClassId", "status");

-- CreateIndex
CREATE INDEX "SeatWaitlist_userId_status_idx" ON "SeatWaitlist"("userId", "status");

-- AddForeignKey
ALTER TABLE "SeatWaitlist" ADD CONSTRAINT "SeatWaitlist_flightScheduleId_fkey" FOREIGN KEY ("flightScheduleId") REFERENCES "FlightSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatWaitlist" ADD CONSTRAINT "SeatWaitlist_seatClassId_fkey" FOREIGN KEY ("seatClassId") REFERENCES "FlightSeatClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatWaitlist" ADD CONSTRAINT "SeatWaitlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

