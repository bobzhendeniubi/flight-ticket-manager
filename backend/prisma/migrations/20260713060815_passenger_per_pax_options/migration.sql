-- AlterTable
ALTER TABLE "Passenger" ADD COLUMN     "singleRoom" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "visaExempt" BOOLEAN NOT NULL DEFAULT false;
