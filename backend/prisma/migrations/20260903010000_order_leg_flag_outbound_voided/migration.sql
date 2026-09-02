-- OrderLegFlag 新增「去程已作废」枚举值。
--
-- 单独一条迁移只做 ADD VALUE，**不能**和下面那条回填合并：Postgres 里新加的枚举值
-- 在同一个事务里还不能被使用（prisma migrate 每条迁移跑在一个事务里），
-- 合在一起会在回填的 CAST 处报 "unsafe use of new value of enum type"。
--
-- IF NOT EXISTS：本值曾以「原地改老迁移」的方式进过部分环境的库，重跑必须幂等。
ALTER TYPE "OrderLegFlag" ADD VALUE IF NOT EXISTS 'OUTBOUND_VOIDED';
