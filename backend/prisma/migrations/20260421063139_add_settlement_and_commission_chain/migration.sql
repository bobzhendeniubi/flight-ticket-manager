-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID', 'VOIDED');

-- AlterTable
ALTER TABLE "CommissionRecord" ADD COLUMN     "chainDepth" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "settlementId" TEXT;

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "grossRevenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "commissionEarned" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "commissionPaidToChildren" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "netCommission" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "prepaymentOffset" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "payableToAgent" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "SettlementStatus" NOT NULL DEFAULT 'DRAFT',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Settlement_period_idx" ON "Settlement"("period");

-- CreateIndex
CREATE INDEX "Settlement_status_idx" ON "Settlement"("status");

-- CreateIndex
CREATE INDEX "Settlement_agentId_period_idx" ON "Settlement"("agentId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_period_agentId_key" ON "Settlement"("period", "agentId");

-- CreateIndex
CREATE INDEX "CommissionRecord_settlementId_idx" ON "CommissionRecord"("settlementId");

-- AddForeignKey
ALTER TABLE "CommissionRecord" ADD CONSTRAINT "CommissionRecord_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
