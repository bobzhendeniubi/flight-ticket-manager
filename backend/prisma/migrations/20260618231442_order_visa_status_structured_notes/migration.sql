-- CreateEnum
CREATE TYPE "VisaRequirement" AS ENUM ('NOT_NEEDED', 'NEEDED', 'E_VISA', 'HAS_VISA');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "noteHotel" TEXT,
ADD COLUMN     "notePayment" TEXT,
ADD COLUMN     "noteSpecial" TEXT,
ADD COLUMN     "noteVisa" TEXT,
ADD COLUMN     "visaStatus" "VisaRequirement";
