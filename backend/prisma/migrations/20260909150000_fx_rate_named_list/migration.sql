-- 汇率表通用化：UsdFxRate → FxRate（命名清单 + 币种）。
--   · supplier 改名 name（汇率名称：签证公司名 / 「酒店越南盾」等，空 = 该币种通用行）
--   · 加 currency（USD / VND；记法：USD 行 = 1 美金折多少人民币，VND 行 = 多少越南盾折 1 人民币）
--   · 唯一键改为（name × currency × effectiveFrom）；存量行 currency 一律 'USD'，取数行为与改前一致
-- 表与列用 RENAME（不是 DROP/CREATE），存量汇率行原样保留。
ALTER TABLE "UsdFxRate" RENAME TO "FxRate";
ALTER TABLE "FxRate" RENAME COLUMN "supplier" TO "name";
ALTER TABLE "FxRate" RENAME CONSTRAINT "UsdFxRate_pkey" TO "FxRate_pkey";
ALTER TABLE "FxRate" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';

-- DropIndex（旧唯一键 / 旧索引）
DROP INDEX "UsdFxRate_supplier_effectiveFrom_key";
DROP INDEX "UsdFxRate_effectiveFrom_idx";

-- CreateIndex
CREATE INDEX "FxRate_currency_effectiveFrom_idx" ON "FxRate"("currency", "effectiveFrom");
CREATE UNIQUE INDEX "FxRate_name_currency_effectiveFrom_key" ON "FxRate"("name", "currency", "effectiveFrom");

-- 酒店房型净房价可填越南盾（与人民币二选一），并记用哪条 VND 汇率行折算
-- AlterTable
ALTER TABLE "HotelRoomType" ADD COLUMN     "costFxName" TEXT,
ADD COLUMN     "costPriceVnd" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "HotelRoomTypeCostPeriod" ADD COLUMN     "costFxName" TEXT,
ADD COLUMN     "costPriceVnd" DECIMAL(14,2),
ALTER COLUMN "costPriceCny" DROP NOT NULL;
