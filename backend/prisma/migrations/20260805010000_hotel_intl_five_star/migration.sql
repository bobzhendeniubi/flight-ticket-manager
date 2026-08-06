-- 产品管理·酒店星级加「国际五星」选项
--
-- 不改 Hotel.starRating 的 1..5 整数语义；国际五星是独立标记，
-- 与结算价日历 SettlementTier.INTL_5STAR「国际五星」对齐口径：
-- 国际五星 = starRating=5 且 intlFiveStar=true。
-- 不参与 hotel-control 随机池星级分类（RANDOM_STAR_TIERS 只按 3/4 星分池，不受影响）。

-- AlterTable
ALTER TABLE "Hotel" ADD COLUMN     "intlFiveStar" BOOLEAN NOT NULL DEFAULT false;
