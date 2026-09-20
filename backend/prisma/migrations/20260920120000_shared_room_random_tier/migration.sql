-- 共享房支持「档次房」（随机档未落位的单也能跨单合住，2026-09-20 拍板 A）。
-- 纯增量：放宽两列非空、新增 randomStarTier 列与索引；存量行（全是酒店房）不动。

-- AlterTable
ALTER TABLE "SharedRoom" ALTER COLUMN "hotelId" DROP NOT NULL;
ALTER TABLE "SharedRoom" ALTER COLUMN "hotelRoomTypeId" DROP NOT NULL;
ALTER TABLE "SharedRoom" ADD COLUMN "randomStarTier" INTEGER;

-- CreateIndex
CREATE INDEX "SharedRoom_randomStarTier_checkIn_checkOut_idx" ON "SharedRoom"("randomStarTier", "checkIn", "checkOut");

-- 两种形态二选一：酒店房（hotelId + hotelRoomTypeId 非空、randomStarTier 空）
-- 或档次房（hotelId / hotelRoomTypeId 空、randomStarTier 非空）。
ALTER TABLE "SharedRoom" ADD CONSTRAINT "SharedRoom_scope_check" CHECK (
  ("hotelId" IS NOT NULL AND "hotelRoomTypeId" IS NOT NULL AND "randomStarTier" IS NULL)
  OR ("hotelId" IS NULL AND "hotelRoomTypeId" IS NULL AND "randomStarTier" IS NOT NULL)
);
