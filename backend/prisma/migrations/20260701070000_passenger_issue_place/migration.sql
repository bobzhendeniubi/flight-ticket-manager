-- AlterTable: 护照签发地点（城市/机关文本，OCR 识别或手填，选填）—— 区别于 ISO-2 颁发国 passportIssueCountry
ALTER TABLE "Passenger" ADD COLUMN "passportIssuePlace" TEXT;
