-- AlterTable
ALTER TABLE "Bundle" ADD COLUMN     "hotelNights" INTEGER,
ADD COLUMN     "hotelRoomTypeId" TEXT;

-- AddForeignKey
ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_hotelRoomTypeId_fkey" FOREIGN KEY ("hotelRoomTypeId") REFERENCES "HotelRoomType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
