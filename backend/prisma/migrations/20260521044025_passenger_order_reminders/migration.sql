-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('M', 'F', 'X');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ReminderPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedById" TEXT,
ADD COLUMN     "internalNotes" TEXT,
ADD COLUMN     "roomAssignment" JSONB;

-- AlterTable
ALTER TABLE "Passenger" ADD COLUMN     "addressCity" TEXT,
ADD COLUMN     "addressCountry" TEXT,
ADD COLUMN     "addressDetails" TEXT,
ADD COLUMN     "addressState" TEXT,
ADD COLUMN     "addressType" TEXT,
ADD COLUMN     "addressZip" TEXT,
ADD COLUMN     "bedPref" TEXT,
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "gender" "Gender",
ADD COLUMN     "lastName" TEXT,
ADD COLUMN     "passportExpiry" DATE,
ADD COLUMN     "passportIssueCountry" TEXT,
ADD COLUMN     "passportPhotoUrl" TEXT,
ADD COLUMN     "placeOfBirth" TEXT,
ADD COLUMN     "title" TEXT,
ADD COLUMN     "visaCountryOfApplication" TEXT,
ADD COLUMN     "visaExpiry" DATE,
ADD COLUMN     "visaIssueDate" DATE,
ADD COLUMN     "visaNumber" TEXT,
ADD COLUMN     "visaPlaceOfIssue" TEXT,
ADD COLUMN     "visaType" TEXT;

-- CreateTable
CREATE TABLE "OperationalReminder" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "createdById" TEXT NOT NULL,
    "claimedById" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "dueAt" DATE,
    "priority" "ReminderPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "ReminderStatus" NOT NULL DEFAULT 'OPEN',
    "attachmentUrl" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationalReminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperationalReminder_orderId_idx" ON "OperationalReminder"("orderId");

-- CreateIndex
CREATE INDEX "OperationalReminder_status_priority_dueAt_idx" ON "OperationalReminder"("status", "priority", "dueAt");

-- CreateIndex
CREATE INDEX "OperationalReminder_claimedById_status_idx" ON "OperationalReminder"("claimedById", "status");

-- CreateIndex
CREATE INDEX "Order_claimedById_idx" ON "Order"("claimedById");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalReminder" ADD CONSTRAINT "OperationalReminder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalReminder" ADD CONSTRAINT "OperationalReminder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalReminder" ADD CONSTRAINT "OperationalReminder_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
