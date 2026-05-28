-- AlterTable
ALTER TABLE "FlightSchedule" ADD COLUMN     "charterCostCny" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "HotelRoomType" ADD COLUMN     "costPriceCny" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "totalCostCny" DECIMAL(12,2),
ADD COLUMN     "unitCostCny" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN     "costPriceCny" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Visa" ADD COLUMN     "costPriceCny" DECIMAL(10,2);
