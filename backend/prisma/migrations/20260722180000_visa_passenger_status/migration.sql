-- CreateEnum
CREATE TYPE "VisaSubmissionStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'CONFIRMED');

-- AlterTable: 乘客送签进度（部分送签用）。@default(PENDING) → 存量行天然回落「待处理」。
ALTER TABLE "Passenger" ADD COLUMN     "visaSubmissionStatus" "VisaSubmissionStatus" NOT NULL DEFAULT 'PENDING';
