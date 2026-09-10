-- 车队（Transfer）结算价可填越南盾（与人民币二选一），并记用哪条 VND 汇率行折算（照酒店净房价那套）。
--   · costPriceVnd：越南盾/份；costFxName：FxRate.name（NULL = 该币种通用行）
--   · 存量行两列均为 NULL，取价行为与改前一致（仍按 costPriceCny）
-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN     "costFxName" TEXT,
ADD COLUMN     "costPriceVnd" DECIMAL(14,2);
