-- 常旅客权益核销台账（append-only：核销/冲正只增不改不删）+ 在订未飞快照列

-- AlterTable
ALTER TABLE "TravelerProfile" ADD COLUMN     "pendingTripCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TravelerBenefitRedemption" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "tripsUsed" INTEGER NOT NULL,
    "benefit" TEXT NOT NULL,
    "note" TEXT,
    "reversalOfId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TravelerBenefitRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TravelerBenefitRedemption_reversalOfId_key" ON "TravelerBenefitRedemption"("reversalOfId");

-- CreateIndex
CREATE INDEX "TravelerBenefitRedemption_profileId_idx" ON "TravelerBenefitRedemption"("profileId");

-- CreateIndex
CREATE INDEX "TravelerBenefitRedemption_createdAt_idx" ON "TravelerBenefitRedemption"("createdAt");

-- AddForeignKey
ALTER TABLE "TravelerBenefitRedemption" ADD CONSTRAINT "TravelerBenefitRedemption_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "TravelerProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelerBenefitRedemption" ADD CONSTRAINT "TravelerBenefitRedemption_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "TravelerBenefitRedemption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

