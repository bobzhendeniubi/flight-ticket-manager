-- 供应商应付账单 + 明细 + 付款记录（纯增量，三张全新表）
--
-- 不动任何既有表的既有列；只被新表反向引用（外键长在新表这一侧，老表零改动）。
-- 不回填、无数据迁移。
--
-- 回滚：逆序删掉三张表与两个枚举即可，老表无痕（见本批 commit message）。

-- CreateEnum
CREATE TYPE "SupplierInvoicePeriodKind" AS ENUM ('FLIGHT_SCHEDULE', 'MONTH', 'CUSTOM');

-- CreateEnum
CREATE TYPE "SupplierInvoiceStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'PARTIALLY_PAID', 'PAID', 'DISPUTED');

-- CreateTable
CREATE TABLE "SupplierInvoice" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "invoiceNo" TEXT,
    "periodKind" "SupplierInvoicePeriodKind" NOT NULL,
    "flightScheduleId" TEXT,
    "periodMonth" VARCHAR(7),
    "periodFrom" DATE,
    "periodTo" DATE,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CNY',
    "amount" DECIMAL(14,2) NOT NULL,
    "fxRate" DECIMAL(12,6),
    "amountCny" DECIMAL(14,2) NOT NULL,
    "status" "SupplierInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "attachmentUrl" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierInvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "quantity" DECIMAL(12,2),
    "amount" DECIMAL(14,2) NOT NULL,
    "amountCny" DECIMAL(14,2) NOT NULL,
    "flightScheduleId" TEXT,
    "hotelBlockPeriodId" TEXT,
    "orderId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPayment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "paidOn" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "fxRate" DECIMAL(12,6),
    "amountCny" DECIMAL(14,2) NOT NULL,
    "method" VARCHAR(16) NOT NULL,
    "reference" TEXT,
    "payerLabel" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierInvoice_supplierId_status_idx" ON "SupplierInvoice"("supplierId", "status");

-- CreateIndex
CREATE INDEX "SupplierInvoice_periodMonth_idx" ON "SupplierInvoice"("periodMonth");

-- CreateIndex
CREATE INDEX "SupplierInvoice_flightScheduleId_idx" ON "SupplierInvoice"("flightScheduleId");

-- CreateIndex
CREATE INDEX "SupplierInvoice_periodFrom_periodTo_idx" ON "SupplierInvoice"("periodFrom", "periodTo");

-- CreateIndex
CREATE INDEX "SupplierInvoiceLine_invoiceId_idx" ON "SupplierInvoiceLine"("invoiceId");

-- CreateIndex
CREATE INDEX "SupplierInvoiceLine_flightScheduleId_idx" ON "SupplierInvoiceLine"("flightScheduleId");

-- CreateIndex
CREATE INDEX "SupplierInvoiceLine_hotelBlockPeriodId_idx" ON "SupplierInvoiceLine"("hotelBlockPeriodId");

-- CreateIndex
CREATE INDEX "SupplierInvoiceLine_orderId_idx" ON "SupplierInvoiceLine"("orderId");

-- CreateIndex
CREATE INDEX "SupplierPayment_invoiceId_idx" ON "SupplierPayment"("invoiceId");

-- CreateIndex
CREATE INDEX "SupplierPayment_paidOn_idx" ON "SupplierPayment"("paidOn");

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_flightScheduleId_fkey" FOREIGN KEY ("flightScheduleId") REFERENCES "FlightSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_flightScheduleId_fkey" FOREIGN KEY ("flightScheduleId") REFERENCES "FlightSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_hotelBlockPeriodId_fkey" FOREIGN KEY ("hotelBlockPeriodId") REFERENCES "HotelBlockPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
