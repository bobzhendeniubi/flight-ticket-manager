-- Finance breakdown for 贺帅/寇露/出纳 feedback:
--   (1) 4 new per-pax cost fields on FlightSchedule + FlightCostPeriod (燃油/旺季附加/机型调整/起降折扣)
--   (2) New OrderCostItem table for 订单级杂项成本 (导游/赠送/手续费/其他)
--   (3) New OrderItemKind values: GUIDE, UPGRADE_CHANGE, OVERSALE
--   (4) Order: expectedAmountCny + expectedAmountLocked (出纳：预期到账锁定)
-- Pure additive; zero DROP, zero data loss.

-- (1) FlightSchedule + FlightCostPeriod: 4 new per-pax CNY cost fields
ALTER TABLE "FlightSchedule"
  ADD COLUMN "fuelCostCny" DECIMAL(10,2),
  ADD COLUMN "peakSurchargeCny" DECIMAL(10,2),
  ADD COLUMN "aircraftAdjustCny" DECIMAL(10,2),
  ADD COLUMN "takeoffDiscountCny" DECIMAL(10,2);

ALTER TABLE "FlightCostPeriod"
  ADD COLUMN "fuelCostCny" DECIMAL(10,2),
  ADD COLUMN "peakSurchargeCny" DECIMAL(10,2),
  ADD COLUMN "aircraftAdjustCny" DECIMAL(10,2),
  ADD COLUMN "takeoffDiscountCny" DECIMAL(10,2);

-- (2) Order: 出纳预期到账锁定
ALTER TABLE "Order"
  ADD COLUMN "expectedAmountCny" DECIMAL(12,2),
  ADD COLUMN "expectedAmountLocked" BOOLEAN NOT NULL DEFAULT false;

-- (3) Extend OrderItemKind enum
ALTER TYPE "OrderItemKind" ADD VALUE IF NOT EXISTS 'GUIDE';
ALTER TYPE "OrderItemKind" ADD VALUE IF NOT EXISTS 'UPGRADE_CHANGE';
ALTER TYPE "OrderItemKind" ADD VALUE IF NOT EXISTS 'OVERSALE';

-- (4) OrderCostCategory enum + OrderCostItem table
CREATE TYPE "OrderCostCategory" AS ENUM ('GUIDE_SERVICE', 'COMP_GIFT', 'HANDLING_FEE', 'OTHER');

CREATE TABLE "OrderCostItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "category" "OrderCostCategory" NOT NULL,
    "amountCny" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderCostItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderCostItem_orderId_category_idx"
  ON "OrderCostItem"("orderId", "category");

ALTER TABLE "OrderCostItem"
  ADD CONSTRAINT "OrderCostItem_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
