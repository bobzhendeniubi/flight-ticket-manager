-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "parentAgentId" TEXT,
ADD COLUMN     "tier" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "Agent_parentAgentId_idx" ON "Agent"("parentAgentId");

-- CreateIndex
CREATE INDEX "Agent_tier_idx" ON "Agent"("tier");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_parentAgentId_fkey" FOREIGN KEY ("parentAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
