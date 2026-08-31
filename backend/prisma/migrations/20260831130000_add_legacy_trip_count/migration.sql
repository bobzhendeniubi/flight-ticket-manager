-- 常旅客飞行次数并入老系统历史次数。
-- 纯增列；既有快照先以 0 填充，后续档案重算按老系统口径回填。
ALTER TABLE "TravelerProfile"
ADD COLUMN "legacyTripCount" INTEGER NOT NULL DEFAULT 0;

UPDATE "TravelerProfile" SET "refreshedAt" = TIMESTAMP '2000-01-01 00:00:00';
