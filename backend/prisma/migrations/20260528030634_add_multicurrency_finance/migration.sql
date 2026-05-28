-- AlterTable
ALTER TABLE "FlightSchedule" ADD COLUMN     "airportTaxArrUsd" DECIMAL(10,2),
ADD COLUMN     "airportTaxDepUsd" DECIMAL(10,2),
ADD COLUMN     "ticketCostUsd" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "HotelRoomType" ADD COLUMN     "costPriceVnd" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "Visa" ADD COLUMN     "costPriceUsd" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "ExchangeRate" (
    "id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "rateToCny" DECIMAL(14,6) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRate_currency_kind_key" ON "ExchangeRate"("currency", "kind");
