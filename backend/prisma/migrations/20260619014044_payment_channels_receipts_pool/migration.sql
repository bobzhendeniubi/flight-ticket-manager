-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('OPEN', 'PARTIALLY_ALLOCATED', 'ALLOCATED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ReceiptSource" AS ENUM ('CUSTOMER_UPLOAD', 'STAFF_ENTRY', 'ORDER_OVERPAY');

-- CreateTable
CREATE TABLE "PaymentChannel" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "qrImageUrl" TEXT,
    "accountText" TEXT,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL,
    "receiptNo" TEXT NOT NULL,
    "amountCny" DECIMAL(14,2) NOT NULL,
    "allocatedCny" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "method" "PaymentMethod" NOT NULL,
    "proofUrl" TEXT,
    "payerNote" TEXT,
    "orderHintId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "source" "ReceiptSource" NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'OPEN',
    "refundNote" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptAllocation" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amountCny" DECIMAL(14,2) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentChannel_isActive_sortOrder_idx" ON "PaymentChannel"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_receiptNo_key" ON "Receipt"("receiptNo");

-- CreateIndex
CREATE INDEX "Receipt_status_idx" ON "Receipt"("status");

-- CreateIndex
CREATE INDEX "Receipt_receivedAt_idx" ON "Receipt"("receivedAt");

-- CreateIndex
CREATE INDEX "Receipt_orderHintId_idx" ON "Receipt"("orderHintId");

-- CreateIndex
CREATE INDEX "ReceiptAllocation_receiptId_idx" ON "ReceiptAllocation"("receiptId");

-- CreateIndex
CREATE INDEX "ReceiptAllocation_orderId_idx" ON "ReceiptAllocation"("orderId");

-- AddForeignKey
ALTER TABLE "ReceiptAllocation" ADD CONSTRAINT "ReceiptAllocation_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
