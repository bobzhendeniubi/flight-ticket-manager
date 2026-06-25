-- AlterTable
ALTER TABLE "Bundle" ADD COLUMN     "selfVisaDeductCny" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "roomsBilled" DECIMAL(4,1);
