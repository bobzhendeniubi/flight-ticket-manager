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

-- AlterTable：自动冲正行记触发单（拆单后核销挂源单、触发单是目标单，恢复目标单时靠它找提示）
ALTER TABLE "TravelerBenefitRedemption" ADD COLUMN "triggeredByOrderId" TEXT;

-- CreateIndex
CREATE INDEX "TravelerBenefitRedemption_triggeredByOrderId_idx" ON "TravelerBenefitRedemption"("triggeredByOrderId");

-- 新列在快照重建前恒为 0（可用次数偏保守、不会多给）；把**全表**快照打成过期，
-- 档案列表 / 导出下一次访问即触发全量重建把它填上（做法同 2026-08-31 老系统次数并档）。
-- 过期判定看整表最旧一条 canonical 行（_min(refreshedAt)，见 TravelerProfilesService.ensureFresh
-- 与 orders.export-trip-stats.bootstrapTripCountProfilesIfEmpty）：部署后先点开某一人的详情
-- 只会刷新那一行，其余行仍是这里写的旧值，整表照样触发重建 —— 「下次访问即全量重建」才成立。
UPDATE "TravelerProfile" SET "refreshedAt" = TIMESTAMP '2000-01-01 00:00:00';
