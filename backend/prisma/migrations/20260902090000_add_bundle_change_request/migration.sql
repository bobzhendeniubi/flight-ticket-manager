-- 套餐改档申请（代理提申请 → 运营确认后执行既有套餐改档）。
-- 纯新增：一张新表 + 一个新枚举，不改动任何既有订单数据。

-- CreateEnum
CREATE TYPE "BundleChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "BundleChangeRequest" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "agentId" TEXT,
    "requestedById" TEXT NOT NULL,
    "fromBundleId" TEXT NOT NULL,
    "fromBundleName" TEXT NOT NULL,
    "fromNights" INTEGER,
    "toBundleId" TEXT NOT NULL,
    "toBundleName" TEXT NOT NULL,
    "toNights" INTEGER,
    "note" TEXT,
    "status" "BundleChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "appliedAt" TIMESTAMP(3),
    "appliedDiffCny" DECIMAL(12,2),
    "appliedDiffItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BundleChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BundleChangeRequest_orderId_idx" ON "BundleChangeRequest"("orderId");

-- CreateIndex
CREATE INDEX "BundleChangeRequest_status_createdAt_idx" ON "BundleChangeRequest"("status", "createdAt");

-- 同一订单同时只能挂一条待确认申请。
CREATE UNIQUE INDEX "BundleChangeRequest_one_pending_per_order"
  ON "BundleChangeRequest" ("orderId") WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "BundleChangeRequest" ADD CONSTRAINT "BundleChangeRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleChangeRequest" ADD CONSTRAINT "BundleChangeRequest_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
