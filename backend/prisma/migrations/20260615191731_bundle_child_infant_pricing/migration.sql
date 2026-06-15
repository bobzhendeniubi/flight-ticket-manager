-- AlterTable
ALTER TABLE "Bundle" ADD COLUMN     "childSeatDiscountCnyPerPerson" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "infantPriceCny" INTEGER NOT NULL DEFAULT 0;
