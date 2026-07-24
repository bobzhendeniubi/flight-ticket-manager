-- 航班级「升舱差价」单一配置源 + 「商务舱价格联动经济舱」开关。
ALTER TABLE "Flight"
ADD COLUMN "businessUpgradeCnyPerLeg" INTEGER NOT NULL DEFAULT 700,
ADD COLUMN "businessPriceLinked" BOOLEAN NOT NULL DEFAULT false;

-- 套餐升舱差价改为可空：null = 「跟随航班」（取绑定航班 Flight.businessUpgradeCnyPerLeg）；
-- 非 null = 套餐自有覆盖。存量数据保持原值（多为 700 / 0）不改写，行为不变。
ALTER TABLE "Bundle"
ALTER COLUMN "businessUpgradeCnyPerLeg" DROP NOT NULL,
ALTER COLUMN "businessUpgradeCnyPerLeg" DROP DEFAULT;
