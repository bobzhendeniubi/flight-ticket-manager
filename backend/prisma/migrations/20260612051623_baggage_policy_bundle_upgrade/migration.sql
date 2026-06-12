-- AlterTable
ALTER TABLE "Bundle" ADD COLUMN     "cabinUpgradeCnyPerLeg" DECIMAL(10,2),
ADD COLUMN     "singleSupplementCnyPerNight" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "FlightBaggagePolicy" (
    "id" TEXT NOT NULL,
    "flightId" TEXT NOT NULL,
    "cabin" "CabinClass" NOT NULL,
    "checkedKg" INTEGER,
    "checkedPieces" INTEGER,
    "carryOnKg" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlightBaggagePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FlightBaggagePolicy_flightId_cabin_key" ON "FlightBaggagePolicy"("flightId", "cabin");

-- AddForeignKey
ALTER TABLE "FlightBaggagePolicy" ADD CONSTRAINT "FlightBaggagePolicy_flightId_fkey" FOREIGN KEY ("flightId") REFERENCES "Flight"("id") ON DELETE CASCADE ON UPDATE CASCADE;

