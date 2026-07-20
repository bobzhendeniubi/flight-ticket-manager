-- A2（2026-07-17 拍板）：包机成本汇率四元组（原币种/原币金额/汇率/折算日），可空审计留痕。
-- charterCostCny 仍是唯一入账口径；四字段只回答「这个 CNY 数是按哪天哪个汇率从哪种原币折来的」。
ALTER TABLE "FlightSchedule" ADD COLUMN "charterSourceCurrency" VARCHAR(3);
ALTER TABLE "FlightSchedule" ADD COLUMN "charterSourceAmount" DECIMAL(14,2);
ALTER TABLE "FlightSchedule" ADD COLUMN "charterFxRate" DECIMAL(12,6);
ALTER TABLE "FlightSchedule" ADD COLUMN "charterFxDate" DATE;
ALTER TABLE "FlightCostPeriod" ADD COLUMN "charterSourceCurrency" VARCHAR(3);
ALTER TABLE "FlightCostPeriod" ADD COLUMN "charterSourceAmount" DECIMAL(14,2);
ALTER TABLE "FlightCostPeriod" ADD COLUMN "charterFxRate" DECIMAL(12,6);
ALTER TABLE "FlightCostPeriod" ADD COLUMN "charterFxDate" DATE;
