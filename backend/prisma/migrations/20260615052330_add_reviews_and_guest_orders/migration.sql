-- CreateEnum
CREATE TYPE "ProductReviewType" AS ENUM ('BUNDLE', 'HOTEL', 'TRANSFER', 'VISA', 'FLIGHT');

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_userId_fkey";

-- AlterTable
ALTER TABLE "Bundle" ADD COLUMN     "soldCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Hotel" ADD COLUMN     "soldCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "guestEmail" TEXT,
ADD COLUMN     "guestName" TEXT,
ADD COLUMN     "guestPhone" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN     "soldCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Visa" ADD COLUMN     "soldCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "productType" "ProductReviewType" NOT NULL,
    "productId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "tripType" TEXT,
    "reply" TEXT,
    "orderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Review_productType_productId_idx" ON "Review"("productType", "productId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
