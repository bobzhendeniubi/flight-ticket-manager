ALTER TABLE "Order"
ADD COLUMN "settlementLocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "settlementLockedAt" TIMESTAMP(3),
ADD COLUMN "settlementLockedBy" TEXT;
