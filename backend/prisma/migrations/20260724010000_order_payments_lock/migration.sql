ALTER TABLE "Order"
ADD COLUMN "paymentsLocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "paymentsLockedAt" TIMESTAMP(3),
ADD COLUMN "paymentsLockedBy" TEXT;
