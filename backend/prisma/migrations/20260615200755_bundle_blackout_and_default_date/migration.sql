-- AlterTable
ALTER TABLE "Bundle" ADD COLUMN     "blackoutDates" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "defaultDepartDate" TEXT;
