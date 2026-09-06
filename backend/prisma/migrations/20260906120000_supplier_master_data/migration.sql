-- 供应商主数据（纯增量）
--
-- 新建 Supplier 表 + 在 Hotel/Visa/Flight 上各挂一个可空外键。
-- 不回填任何存量数据：没挂供应商的产品就是没挂，应付账单侧如实展示，绝不按名字猜对应关系。
--
-- 回滚：
--   ALTER TABLE "Flight" DROP COLUMN "supplierId";
--   ALTER TABLE "Visa"   DROP COLUMN "supplierId";
--   ALTER TABLE "Hotel"  DROP COLUMN "supplierId";
--   DROP TABLE "Supplier";
--   DROP TYPE "SupplierType";

-- CreateEnum
CREATE TYPE "SupplierType" AS ENUM ('AIRLINE', 'HOTEL', 'VISA_AGENCY', 'TRANSFER', 'OTHER');

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "type" "SupplierType" NOT NULL,
    "name" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CNY',
    "contactName" TEXT,
    "contactPhone" TEXT,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Supplier_type_isActive_idx" ON "Supplier"("type", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_type_name_key" ON "Supplier"("type", "name");

-- AlterTable
ALTER TABLE "Hotel" ADD COLUMN "supplierId" TEXT;

-- AlterTable
ALTER TABLE "Visa" ADD COLUMN "supplierId" TEXT;

-- AlterTable
ALTER TABLE "Flight" ADD COLUMN "supplierId" TEXT;

-- CreateIndex
CREATE INDEX "Hotel_supplierId_idx" ON "Hotel"("supplierId");

-- CreateIndex
CREATE INDEX "Visa_supplierId_idx" ON "Visa"("supplierId");

-- CreateIndex
CREATE INDEX "Flight_supplierId_idx" ON "Flight"("supplierId");

-- AddForeignKey
ALTER TABLE "Hotel" ADD CONSTRAINT "Hotel_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visa" ADD CONSTRAINT "Visa_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flight" ADD CONSTRAINT "Flight_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
