-- CreateEnum
CREATE TYPE "MarketingPosterKind" AS ENUM ('FLIGHT_ROUTE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "MarketingPosterStatus" AS ENUM ('GENERATING', 'READY', 'NEEDS_REVIEW', 'FAILED');

-- CreateTable
CREATE TABLE "MarketingPoster" (
    "id" TEXT NOT NULL,
    "kind" "MarketingPosterKind" NOT NULL,
    "status" "MarketingPosterStatus" NOT NULL DEFAULT 'GENERATING',
    "title" TEXT NOT NULL,
    "flightId" TEXT,
    "templateKey" TEXT NOT NULL,
    "size" TEXT NOT NULL DEFAULT '1080*1440',
    "imageModel" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "imageDataUrl" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verifyReport" JSONB,
    "copyMoments" TEXT,
    "copyAgent" TEXT,
    "copyXhs" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingPoster_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketingPoster_status_createdAt_idx" ON "MarketingPoster"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MarketingPoster_flightId_idx" ON "MarketingPoster"("flightId");

-- AddForeignKey
ALTER TABLE "MarketingPoster" ADD CONSTRAINT "MarketingPoster_flightId_fkey" FOREIGN KEY ("flightId") REFERENCES "Flight"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingPoster" ADD CONSTRAINT "MarketingPoster_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterEnum：营销中心的审计目标类型
ALTER TYPE "AuditTargetType" ADD VALUE IF NOT EXISTS 'MARKETING';
