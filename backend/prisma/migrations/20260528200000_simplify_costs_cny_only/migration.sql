-- Simplify costs to CNY-only; remove all foreign-exchange handling.
-- Finance keeps charter cost (CNY) + airport tax (now CNY); single-ticket USD cost dropped.

-- Drop the exchange-rate table (FX no longer used).
DROP TABLE "ExchangeRate";

-- FlightSchedule: drop USD cost fields, add CNY airport tax (dep/arr).
ALTER TABLE "FlightSchedule" DROP COLUMN "ticketCostUsd";
ALTER TABLE "FlightSchedule" DROP COLUMN "airportTaxDepUsd";
ALTER TABLE "FlightSchedule" DROP COLUMN "airportTaxArrUsd";
ALTER TABLE "FlightSchedule" ADD COLUMN "airportTaxDepCny" DECIMAL(10,2);
ALTER TABLE "FlightSchedule" ADD COLUMN "airportTaxArrCny" DECIMAL(10,2);

-- HotelRoomType: drop VND cost (CNY only).
ALTER TABLE "HotelRoomType" DROP COLUMN "costPriceVnd";

-- Visa: drop USD cost (CNY only).
ALTER TABLE "Visa" DROP COLUMN "costPriceUsd";
