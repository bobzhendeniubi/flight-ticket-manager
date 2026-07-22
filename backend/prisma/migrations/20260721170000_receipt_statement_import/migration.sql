-- AlterEnum
ALTER TYPE "ReceiptSource" ADD VALUE 'STATEMENT_IMPORT';

-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN "externalTxnId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_externalTxnId_key" ON "Receipt"("externalTxnId");
