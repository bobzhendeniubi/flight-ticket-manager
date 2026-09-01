-- 结算价议价申请（代理提申请 → 运营确认后才由既有调价通道生效）。
-- 纯新增：一张新表 + 一个新枚举，不改动任何既有表/既有订单数据。

-- CreateEnum
CREATE TYPE "SettlementRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "SettlementRequest" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "agentId" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedTotalCny" DECIMAL(12,2) NOT NULL,
    "systemTotalCny" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "status" "SettlementRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "appliedAdjustmentItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SettlementRequest_orderId_idx" ON "SettlementRequest"("orderId");

-- CreateIndex
CREATE INDEX "SettlementRequest_status_createdAt_idx" ON "SettlementRequest"("status", "createdAt");

-- 同一订单同时只能挂一条待确认申请。
-- 数据库级兜底：应用层已在订单行锁内查重并回 409，但那只防得住走这一条代码路径的并发；
-- 部分唯一索引让「一单两条 PENDING」在任何路径下都落不进库。
-- Prisma @@unique 不支持 WHERE 子句 → 手写 raw SQL（口径同 CancellationPolicy_one_default_per_kind）。
CREATE UNIQUE INDEX "SettlementRequest_one_pending_per_order"
  ON "SettlementRequest" ("orderId")
  WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "SettlementRequest" ADD CONSTRAINT "SettlementRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementRequest" ADD CONSTRAINT "SettlementRequest_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
