-- AlterEnum
ALTER TYPE "OrderItemKind" ADD VALUE 'BUNDLE';

-- AlterTable
ALTER TABLE "Hotel" ADD COLUMN     "area" TEXT,
ADD COLUMN     "basePrice" DECIMAL(10,2),
ADD COLUMN     "emoji" TEXT,
ADD COLUMN     "highlight" TEXT,
ADD COLUMN     "nameEn" TEXT,
ADD COLUMN     "rating" DECIMAL(3,2),
ADD COLUMN     "reviewCount" INTEGER;

-- AlterTable
ALTER TABLE "HotelRoomType" ADD COLUMN     "bedType" TEXT,
ADD COLUMN     "priceMultiplier" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "bundleId" TEXT;

-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN     "duration" TEXT,
ADD COLUMN     "emoji" TEXT,
ADD COLUMN     "features" TEXT[],
ADD COLUMN     "photo" TEXT;

-- AlterTable
ALTER TABLE "Visa" ADD COLUMN     "country" TEXT,
ADD COLUMN     "flag" TEXT,
ADD COLUMN     "highlight" TEXT,
ADD COLUMN     "validityMonths" INTEGER,
ADD COLUMN     "visaName" TEXT;

-- CreateTable
CREATE TABLE "Bundle" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT,
    "emoji" TEXT,
    "photo" TEXT,
    "items" JSONB NOT NULL,
    "flightPax" INTEGER NOT NULL DEFAULT 1,
    "groundDiscount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "suitableFor" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bundle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Bundle_isActive_idx" ON "Bundle"("isActive");

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
