-- CreateEnum
CREATE TYPE "SeatLockStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CONSUMED', 'RELEASED');

-- AlterTable
ALTER TABLE "Bundle" ADD COLUMN     "code" TEXT;

-- AlterTable
ALTER TABLE "Hotel" ADD COLUMN     "code" TEXT;

-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN     "code" TEXT;

-- AlterTable
ALTER TABLE "Visa" ADD COLUMN     "code" TEXT;

-- CreateTable
CREATE TABLE "SeatLock" (
    "id" TEXT NOT NULL,
    "flightScheduleId" TEXT NOT NULL,
    "seatClassId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "status" "SeatLockStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeatLock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HotelBlockPeriod" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "dateFrom" DATE NOT NULL,
    "dateTo" DATE NOT NULL,
    "rooms" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HotelBlockPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeatLock_flightScheduleId_seatClassId_status_idx" ON "SeatLock"("flightScheduleId", "seatClassId", "status");

-- CreateIndex
CREATE INDEX "SeatLock_userId_status_idx" ON "SeatLock"("userId", "status");

-- CreateIndex
CREATE INDEX "HotelBlockPeriod_hotelId_dateFrom_dateTo_idx" ON "HotelBlockPeriod"("hotelId", "dateFrom", "dateTo");

-- CreateIndex
CREATE UNIQUE INDEX "Bundle_code_key" ON "Bundle"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Hotel_code_key" ON "Hotel"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_code_key" ON "Transfer"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Visa_code_key" ON "Visa"("code");

-- AddForeignKey
ALTER TABLE "SeatLock" ADD CONSTRAINT "SeatLock_flightScheduleId_fkey" FOREIGN KEY ("flightScheduleId") REFERENCES "FlightSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatLock" ADD CONSTRAINT "SeatLock_seatClassId_fkey" FOREIGN KEY ("seatClassId") REFERENCES "FlightSeatClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeatLock" ADD CONSTRAINT "SeatLock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HotelBlockPeriod" ADD CONSTRAINT "HotelBlockPeriod_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill product codes (H0001/V0001/T0001/B0001 ... ordered by createdAt, id as tiebreak)
WITH numbered AS (
    SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt", "id") AS rn FROM "Hotel"
)
UPDATE "Hotel" t
SET "code" = 'H' || LPAD(numbered.rn::TEXT, 4, '0')
FROM numbered
WHERE t."id" = numbered."id" AND t."code" IS NULL;

WITH numbered AS (
    SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt", "id") AS rn FROM "Visa"
)
UPDATE "Visa" t
SET "code" = 'V' || LPAD(numbered.rn::TEXT, 4, '0')
FROM numbered
WHERE t."id" = numbered."id" AND t."code" IS NULL;

WITH numbered AS (
    SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt", "id") AS rn FROM "Transfer"
)
UPDATE "Transfer" t
SET "code" = 'T' || LPAD(numbered.rn::TEXT, 4, '0')
FROM numbered
WHERE t."id" = numbered."id" AND t."code" IS NULL;

WITH numbered AS (
    SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt", "id") AS rn FROM "Bundle"
)
UPDATE "Bundle" t
SET "code" = 'B' || LPAD(numbered.rn::TEXT, 4, '0')
FROM numbered
WHERE t."id" = numbered."id" AND t."code" IS NULL;
