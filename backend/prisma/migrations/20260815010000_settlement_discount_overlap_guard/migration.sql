-- 数据库级兜底：即使两个并发 upsert 都在应用层读检查通过，也不能落入同组重叠的启用规则。
-- 排他约束无法由 Prisma schema 表达，故在迁移中手写；mock 单测只验证应用层查询/错误转换。
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "SettlementDiscountRule"
    ADD CONSTRAINT "SettlementDiscountRule_active_window_excl"
    EXCLUDE USING gist (
        -- enum 列直接参与（btree_gist 原生支持枚举等值）；enum::text cast 非 IMMUTABLE，不能进索引表达式。
        "kind" WITH =,
        (COALESCE("agentId", '')) WITH =,
        "tier" WITH =,
        "nights" WITH =,
        daterange("startDate", "endDate", '[]') WITH &&
    )
    WHERE ("isActive");
