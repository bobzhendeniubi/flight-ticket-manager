-- 结算价日历 / 立减规则加「航线」维度（routeKey）
--
-- 为什么：两张表的键此前只有「档次 × 晚数 × 出发日」，schema 注释自认「当前单一航线」。
-- 第二条航线一开，新线套餐只要配了 settlementTier/settlementNights 就会命中岘港线的价——
-- 代理按错线的价结算。于是把航线做成键的第一维：
--   · SettlementRate         唯一键 (tier, nights, departDate) → (routeKey, tier, nights, departDate)
--   · SettlementDiscountRule 同组键 (kind, agentId, tier, nights) → (routeKey, kind, agentId, tier, nights)
--     （应用层重叠校验 + 数据库排他约束都按新组键）
--
-- 回填口径：迁移前系统只有澳门-岘港一条线，存量行全部标 'MFM-DAD'（去程方向「起飞-到达」机场码）。
-- 之后取价一律从套餐绑定的航班派生航线（modules/products/bundle-route.ts），派生不到 = 不取价，
-- 不再有任何「默认航线」兜底。
--
-- 三步走（Prisma 默认生成的「直接加 NOT NULL 列」对存量行会报错）：加可空列 → 回填 → 设 NOT NULL。

-- ── SettlementRate ─────────────────────────────────────────────────────────
ALTER TABLE "SettlementRate" ADD COLUMN "routeKey" TEXT;
UPDATE "SettlementRate" SET "routeKey" = 'MFM-DAD' WHERE "routeKey" IS NULL;
ALTER TABLE "SettlementRate" ALTER COLUMN "routeKey" SET NOT NULL;

-- 旧唯一键退场，新唯一键把 routeKey 放最前
DROP INDEX "SettlementRate_tier_nights_departDate_key";
CREATE UNIQUE INDEX "SettlementRate_routeKey_tier_nights_departDate_key"
    ON "SettlementRate"("routeKey", "tier", "nights", "departDate");
CREATE INDEX "SettlementRate_routeKey_idx" ON "SettlementRate"("routeKey");

-- ── SettlementDiscountRule ─────────────────────────────────────────────────
ALTER TABLE "SettlementDiscountRule" ADD COLUMN "routeKey" TEXT;
UPDATE "SettlementDiscountRule" SET "routeKey" = 'MFM-DAD' WHERE "routeKey" IS NULL;
ALTER TABLE "SettlementDiscountRule" ALTER COLUMN "routeKey" SET NOT NULL;

-- 组键索引：显式命名（默认拼接名超过 63 字符会被 Postgres 截断，导致 schema/DB 漂移）
DROP INDEX "SettlementDiscountRule_kind_agentId_tier_nights_startDate_idx";
CREATE INDEX "SettlementDiscountRule_route_kind_agent_tier_nights_start_idx"
    ON "SettlementDiscountRule"("routeKey", "kind", "agentId", "tier", "nights", "startDate");
CREATE INDEX "SettlementDiscountRule_routeKey_idx" ON "SettlementDiscountRule"("routeKey");

-- 排他约束重建：同组「启用窗口不重叠」的组键加上 routeKey（不同航线的同档同晚同窗口规则互不冲突）。
-- 延续 20260815010000 的写法：enum 列直接参与（btree_gist 支持枚举等值），不做 ::text cast。
ALTER TABLE "SettlementDiscountRule" DROP CONSTRAINT "SettlementDiscountRule_active_window_excl";
ALTER TABLE "SettlementDiscountRule"
    ADD CONSTRAINT "SettlementDiscountRule_active_window_excl"
    EXCLUDE USING gist (
        "routeKey" WITH =,
        "kind" WITH =,
        (COALESCE("agentId", '')) WITH =,
        "tier" WITH =,
        "nights" WITH =,
        daterange("startDate", "endDate", '[]') WITH &&
    )
    WHERE ("isActive");
