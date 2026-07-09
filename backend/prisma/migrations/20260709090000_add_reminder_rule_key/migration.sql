-- AlterTable
-- 规则化自动生成提醒的幂等键：BALANCE:{orderId}:{出发日} 等；手工创建的提醒为 NULL。
-- 纯加列（可空），存量行不受影响；唯一索引保证同一规则键只生成一条，重复生成静默跳过。
ALTER TABLE "OperationalReminder" ADD COLUMN "ruleKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "OperationalReminder_ruleKey_key" ON "OperationalReminder"("ruleKey");
