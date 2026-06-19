-- CreateEnum
CREATE TYPE "SettlementMode" AS ENUM ('PER_ORDER', 'MONTHLY');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "settlementMode" "SettlementMode" NOT NULL DEFAULT 'PER_ORDER';
