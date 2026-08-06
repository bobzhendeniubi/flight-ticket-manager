-- 指定酒店加价（CNY/人）
--
-- 套餐按「星级随机」报价；客人点名要住某家酒店时，按占座人数加收该酒店配置的每人差价
-- （业务口径：同业报价基础上按指定酒店加收，各酒店差价不同，运营各配各的）。
-- 0 = 指定本酒店不加价。仅套餐录单「指定酒店」路径读取；单独 HOTEL 行按房型价成交，不叠加。

-- AlterTable
ALTER TABLE "Hotel" ADD COLUMN     "designationSurchargeCnyPerPerson" INTEGER NOT NULL DEFAULT 0;
