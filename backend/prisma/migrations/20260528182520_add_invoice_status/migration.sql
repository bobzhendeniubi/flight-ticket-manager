-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('NONE', 'REQUESTED', 'ISSUED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "invoiceStatus" "InvoiceStatus" NOT NULL DEFAULT 'NONE';
