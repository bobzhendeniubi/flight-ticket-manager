-- 结算价日历上的固定立减规则（代理专属/代理兜底/散客）
CREATE TYPE "SettlementDiscountKind" AS ENUM ('AGENT', 'AGENT_DEFAULT', 'RETAIL');

CREATE TABLE "SettlementDiscountRule" (
    "id" TEXT NOT NULL,
    "kind" "SettlementDiscountKind" NOT NULL,
    "agentId" TEXT,
    "tier" "SettlementTier" NOT NULL,
    "nights" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "discountPerPersonCny" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementDiscountRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SettlementDiscountRule_kind_agentId_tier_nights_startDate_idx"
    ON "SettlementDiscountRule"("kind", "agentId", "tier", "nights", "startDate");
CREATE INDEX "SettlementDiscountRule_agentId_idx"
    ON "SettlementDiscountRule"("agentId");

ALTER TABLE "SettlementDiscountRule"
    ADD CONSTRAINT "SettlementDiscountRule_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
