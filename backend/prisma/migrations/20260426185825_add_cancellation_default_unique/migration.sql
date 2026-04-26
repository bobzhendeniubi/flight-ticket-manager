-- 同一个 productKind 最多一条 isDefault=true 的策略
-- Postgres partial unique index — Prisma @@unique 不直接支持 WHERE 子句，走 raw SQL
CREATE UNIQUE INDEX "CancellationPolicy_one_default_per_kind"
  ON "CancellationPolicy" ("productKind")
  WHERE "isDefault" = true;