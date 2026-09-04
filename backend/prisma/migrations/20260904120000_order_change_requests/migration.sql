-- 改单申请（代理过了下单当天 → 提申请，运营一键执行）。
-- 纯新增：一张新表 + 两个新枚举，不改动任何既有订单数据。

-- CreateEnum
CREATE TYPE "OrderChangeKind" AS ENUM ('FLIGHT', 'VISA', 'HOTEL', 'CABIN');

-- CreateEnum
CREATE TYPE "OrderChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "OrderChangeRequest" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "agentId" TEXT,
    "requestedById" TEXT NOT NULL,
    "batchId" TEXT,
    "kind" "OrderChangeKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "note" TEXT,
    "status" "OrderChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "appliedAt" TIMESTAMP(3),
    "applyError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderChangeRequest_orderId_status_idx" ON "OrderChangeRequest"("orderId", "status");

-- CreateIndex
CREATE INDEX "OrderChangeRequest_status_createdAt_idx" ON "OrderChangeRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OrderChangeRequest_agentId_status_idx" ON "OrderChangeRequest"("agentId", "status");

-- 同一订单同一类改动同时只能挂一条待处理申请（改班次和改签证互不挤占）。
CREATE UNIQUE INDEX "OrderChangeRequest_one_pending_per_order_kind"
  ON "OrderChangeRequest" ("orderId", "kind") WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "OrderChangeRequest" ADD CONSTRAINT "OrderChangeRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderChangeRequest" ADD CONSTRAINT "OrderChangeRequest_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
