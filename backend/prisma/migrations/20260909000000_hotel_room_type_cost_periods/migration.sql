-- 酒店房型净房价按日期区间维护（财务成本侧）：区间价优先于房型缺省 costPriceCny
-- CreateTable
CREATE TABLE "HotelRoomTypeCostPeriod" (
    "id" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE NOT NULL,
    "costPriceCny" DECIMAL(10,2) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HotelRoomTypeCostPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HotelRoomTypeCostPeriod_roomTypeId_effectiveFrom_effectiveT_idx" ON "HotelRoomTypeCostPeriod"("roomTypeId", "effectiveFrom", "effectiveTo");

-- AddForeignKey
ALTER TABLE "HotelRoomTypeCostPeriod" ADD CONSTRAINT "HotelRoomTypeCostPeriod_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "HotelRoomType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
