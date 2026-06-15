/*
  Bundle add-on rates — 把"自愿升级展示价"升级为 server-priced add-on 费率：
    - singleSupplementCnyPerNight: Decimal(10,2)? → INT NOT NULL DEFAULT 80（一个人住酒店/单人入住，/晚）
    - cabinUpgradeCnyPerLeg(Decimal?) → 重命名为 businessUpgradeCnyPerLeg，INT NOT NULL DEFAULT 700（升舱商务，/航段）
    - 新增 legs INT NOT NULL DEFAULT 2（机票航段数，来回=2）

  历史行（display 字段从未被 seed 填充，多为 NULL）：先回填默认值再加 NOT NULL，避免 migrate 失败。
  cabinUpgradeCnyPerLeg 若有历史值则四舍五入迁移到新列，否则用默认 700。
*/

-- 1) 新列：升舱费率（先可空，回填后置 NOT NULL）+ 航段数
ALTER TABLE "Bundle" ADD COLUMN "businessUpgradeCnyPerLeg" INTEGER;
ALTER TABLE "Bundle" ADD COLUMN "legs" INTEGER NOT NULL DEFAULT 2;

-- 2) 迁移旧升舱列数据（Decimal → 四舍五入 Int）；NULL 落默认 700
UPDATE "Bundle"
SET "businessUpgradeCnyPerLeg" = COALESCE(ROUND("cabinUpgradeCnyPerLeg")::INTEGER, 700);
ALTER TABLE "Bundle" ALTER COLUMN "businessUpgradeCnyPerLeg" SET NOT NULL;
ALTER TABLE "Bundle" ALTER COLUMN "businessUpgradeCnyPerLeg" SET DEFAULT 700;

-- 3) 删除旧升舱列
ALTER TABLE "Bundle" DROP COLUMN "cabinUpgradeCnyPerLeg";

-- 4) 单人入住房差：先回填 NULL → 80，再 Decimal → Int + NOT NULL + 默认 80
UPDATE "Bundle"
SET "singleSupplementCnyPerNight" = 80
WHERE "singleSupplementCnyPerNight" IS NULL;
ALTER TABLE "Bundle" ALTER COLUMN "singleSupplementCnyPerNight" SET DATA TYPE INTEGER USING ROUND("singleSupplementCnyPerNight")::INTEGER;
ALTER TABLE "Bundle" ALTER COLUMN "singleSupplementCnyPerNight" SET NOT NULL;
ALTER TABLE "Bundle" ALTER COLUMN "singleSupplementCnyPerNight" SET DEFAULT 80;
