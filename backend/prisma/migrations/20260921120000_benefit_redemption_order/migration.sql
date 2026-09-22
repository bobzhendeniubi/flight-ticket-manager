-- 常旅客可用次数口径改为「已飞 + 已付款在订未飞 − 已核销」，核销可挂订单号（2026-09-21 拍板）。
-- 纯增量：两列新增 + 一条外键 + 一个索引；存量台账行 orderId 一律为空（保留手动冲正）。

-- AlterTable：档案快照多存一份「已付款在订未飞」
ALTER TABLE "TravelerProfile" ADD COLUMN "pendingPaidTripCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable：台账行可挂订单
ALTER TABLE "TravelerBenefitRedemption" ADD COLUMN "orderId" TEXT;

-- CreateIndex
CREATE INDEX "TravelerBenefitRedemption_orderId_idx" ON "TravelerBenefitRedemption"("orderId");

-- AddForeignKey：订单硬删时只置空挂载，台账行本身永不随单删除
ALTER TABLE "TravelerBenefitRedemption" ADD CONSTRAINT "TravelerBenefitRedemption_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 新列在快照重建前恒为 0（可用次数偏保守、不会多给）；把快照打成过期，
-- 档案列表 / 导出下一次访问即触发全量重建把它填上（做法同 2026-08-31 老系统次数并档）。
UPDATE "TravelerProfile" SET "refreshedAt" = TIMESTAMP '2000-01-01 00:00:00';
