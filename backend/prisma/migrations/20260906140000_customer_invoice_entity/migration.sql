-- 发票实体（纯增量，两张全新表）
--
-- ⚠️ 与 Order 上的「开票」三个布尔位（outboundInvoiced / returnInvoiced / systemInvoiced）
--    以及旧的 Order.invoiceStatus 完全无关。本迁移**不含任何 ALTER TABLE "Order"**，
--    那三个布尔位是票务岗的出票进度，一个字都不动。
--
-- 不回填、无数据迁移。
-- 回滚：逆序删掉 InvoiceOrder / Invoice 两张表与两个枚举即可，老表无痕。

-- CreateEnum
CREATE TYPE "InvoiceType" AS ENUM ('VAT_SPECIAL', 'VAT_GENERAL', 'RECEIPT');

-- CreateEnum
CREATE TYPE "InvoiceRecordStatus" AS ENUM ('REQUESTED', 'ISSUED', 'VOID');

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "taxNo" TEXT,
    "billingInfo" TEXT,
    "type" "InvoiceType" NOT NULL,
    "amountCny" DECIMAL(12,2) NOT NULL,
    "status" "InvoiceRecordStatus" NOT NULL DEFAULT 'REQUESTED',
    "invoiceNo" TEXT,
    "issuedAt" DATE,
    "attachmentUrl" TEXT,
    "requestedByUserId" TEXT,
    "agentId" TEXT,
    "requestNote" TEXT,
    "voidReason" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "issuedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceOrder" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amountCny" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Invoice_status_createdAt_idx" ON "Invoice"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Invoice_agentId_status_idx" ON "Invoice"("agentId", "status");

-- CreateIndex
CREATE INDEX "Invoice_requestedByUserId_idx" ON "Invoice"("requestedByUserId");

-- CreateIndex
CREATE INDEX "InvoiceOrder_orderId_idx" ON "InvoiceOrder"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceOrder_invoiceId_orderId_key" ON "InvoiceOrder"("invoiceId", "orderId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceOrder" ADD CONSTRAINT "InvoiceOrder_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceOrder" ADD CONSTRAINT "InvoiceOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
