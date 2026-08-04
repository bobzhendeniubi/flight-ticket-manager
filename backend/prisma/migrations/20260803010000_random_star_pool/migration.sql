-- 星级随机池（三星随机 / 四星随机）：包房计划与订单占房行都支持「只认星级、不认具体酒店」。
--   HotelBlockPeriod.hotelId 放开 NOT NULL —— NULL = 星级随机池周期（randomStarTier 非空）。
--   HotelBlockPeriod.randomStarTier / OrderItem.randomStarTier：3=三星随机、4=四星随机。
-- 存量数据全部是具体酒店周期/占房行，两列一律 NULL，语义与迁移前完全一致。

-- AlterTable
ALTER TABLE "HotelBlockPeriod" ADD COLUMN     "randomStarTier" INTEGER,
ALTER COLUMN "hotelId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "randomStarTier" INTEGER;

-- CreateIndex
CREATE INDEX "HotelBlockPeriod_randomStarTier_dateFrom_dateTo_idx" ON "HotelBlockPeriod"("randomStarTier", "dateFrom", "dateTo");
