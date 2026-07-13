-- CreateEnum
CREATE TYPE "VisaIssuanceMethod" AS ENUM ('E_VISA', 'STICKER', 'ARRIVAL', 'OTHER');

-- CreateEnum
CREATE TYPE "VisaEntryType" AS ENUM ('SINGLE', 'MULTIPLE');

-- AlterTable
ALTER TABLE "Visa" ADD COLUMN     "entryType" "VisaEntryType",
ADD COLUMN     "issuanceMethod" "VisaIssuanceMethod";

-- Backfill 存量签证产品分类（启发式：按 visaName/visaType 关键词猜签发方式/入境次数；
-- 未命中留 NULL，由运营在产品表单里手工补）。issuanceMethod 三条按「电子签→落地签→贴纸签」
-- 顺序匹配，entryType 按「单次→多次」顺序匹配，且都只落在当前仍是 NULL 的行上，避免互相覆盖。
UPDATE "Visa"
SET "issuanceMethod" = 'E_VISA'
WHERE "issuanceMethod" IS NULL
  AND ("visaName" ~* '电子|e_visa|evisa' OR "visaType" ~* '电子|e_visa|evisa');

UPDATE "Visa"
SET "issuanceMethod" = 'ARRIVAL'
WHERE "issuanceMethod" IS NULL
  AND ("visaName" ~* '落地|arrival' OR "visaType" ~* '落地|arrival');

UPDATE "Visa"
SET "issuanceMethod" = 'STICKER'
WHERE "issuanceMethod" IS NULL
  AND ("visaName" ~* '贴纸|sticker' OR "visaType" ~* '贴纸|sticker');

UPDATE "Visa"
SET "entryType" = 'SINGLE'
WHERE "entryType" IS NULL
  AND ("visaName" ~* '单次|single' OR "visaType" ~* '单次|single');

UPDATE "Visa"
SET "entryType" = 'MULTIPLE'
WHERE "entryType" IS NULL
  AND ("visaName" ~* '多次|multiple|1y|90d.*多次' OR "visaType" ~* '多次|multiple|1y|90d.*多次');
