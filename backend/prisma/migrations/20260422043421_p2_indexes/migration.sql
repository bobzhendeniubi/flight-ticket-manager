-- CreateIndex
CREATE INDEX "CommissionRecord_agentId_status_createdAt_idx" ON "CommissionRecord"("agentId", "status", "createdAt");
