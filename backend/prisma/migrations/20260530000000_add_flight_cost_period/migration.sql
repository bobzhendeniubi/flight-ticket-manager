-- Add FlightCostPeriod: per-(flight, date-range) charter + airport-tax defaults.
-- Pure ADD TABLE; does not touch FlightSchedule or any existing column.
-- Cost resolution: schedule.<field> override > period.<field> default > null.

CREATE TABLE "FlightCostPeriod" (
    "id" TEXT NOT NULL,
    "flightId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE NOT NULL,
    "charterCostCny" DECIMAL(12,2),
    "airportTaxDepCny" DECIMAL(10,2),
    "airportTaxArrCny" DECIMAL(10,2),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlightCostPeriod_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FlightCostPeriod_flightId_effectiveFrom_effectiveTo_idx"
  ON "FlightCostPeriod"("flightId", "effectiveFrom", "effectiveTo");

ALTER TABLE "FlightCostPeriod"
  ADD CONSTRAINT "FlightCostPeriod_flightId_fkey"
  FOREIGN KEY ("flightId") REFERENCES "Flight"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
