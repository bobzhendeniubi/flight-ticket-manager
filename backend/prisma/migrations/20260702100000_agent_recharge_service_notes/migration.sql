-- 0702后台批：代理认款通道 + 套餐服务内容 + 签证停留天数 + 收款码绑代理（纯加法）
-- CreateEnum
CREATE TYPE "AgentRechargeStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- AlterTable
ALTER TABLE "Bundle" ADD COLUMN     "serviceNotes" TEXT;

-- AlterTable
ALTER TABLE "PaymentChannel" ADD COLUMN     "agentId" TEXT;

-- AlterTable
ALTER TABLE "Visa" ADD COLUMN     "stayDays" INTEGER;

-- CreateTable
CREATE TABLE "AgentRechargeRequest" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "amountCny" DECIMAL(14,2) NOT NULL,
    "confirmedAmountCny" DECIMAL(14,2),
    "proofImages" TEXT[],
    "note" TEXT,
    "status" "AgentRechargeStatus" NOT NULL DEFAULT 'PENDING',
    "reviewNote" TEXT,
    "submittedByUserId" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "prepaymentTxId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRechargeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentRechargeRequest_prepaymentTxId_key" ON "AgentRechargeRequest"("prepaymentTxId");

-- CreateIndex
CREATE INDEX "AgentRechargeRequest_status_createdAt_idx" ON "AgentRechargeRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRechargeRequest_agentId_createdAt_idx" ON "AgentRechargeRequest"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentChannel_agentId_idx" ON "PaymentChannel"("agentId");

-- AddForeignKey
ALTER TABLE "AgentRechargeRequest" ADD CONSTRAINT "AgentRechargeRequest_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentChannel" ADD CONSTRAINT "PaymentChannel_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
