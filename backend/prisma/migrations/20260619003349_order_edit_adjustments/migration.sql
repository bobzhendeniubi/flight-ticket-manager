-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "adjustmentCny" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "adjustments" JSONB NOT NULL DEFAULT '[]';
