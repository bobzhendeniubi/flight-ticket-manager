-- AlterTable
ALTER TABLE "Passenger" ADD COLUMN     "chineseName" TEXT,
ADD COLUMN     "passportIssueDate" DATE;

-- CreateTable
CREATE TABLE "AiOcrConfig" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'QWEN',
    "apiKey" TEXT,
    "baseUrl" TEXT,
    "model" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiOcrConfig_pkey" PRIMARY KEY ("id")
);
