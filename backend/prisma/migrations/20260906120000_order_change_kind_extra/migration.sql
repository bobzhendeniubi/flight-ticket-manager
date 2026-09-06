-- 改单申请扩三类：拆单 / 取消单程航段 / 按人改自备签。
--
-- 纯加枚举值，不改任何既有数据、不建表。三类能否被提交由 feature flag
-- AGENT_CHANGE_REQUEST_EXTRA_KINDS 控制（默认关）—— 迁移落库不等于功能开放。
--
-- 单独一条迁移只做 ADD VALUE：Postgres 里新加的枚举值在同一个事务里还不能被使用
-- （prisma migrate 每条迁移跑在一个事务里），与任何回填/写入合并会报
-- "unsafe use of new value of enum type"。
-- IF NOT EXISTS：让重跑幂等。
ALTER TYPE "OrderChangeKind" ADD VALUE IF NOT EXISTS 'SPLIT';
ALTER TYPE "OrderChangeKind" ADD VALUE IF NOT EXISTS 'CANCEL_LEG';
ALTER TYPE "OrderChangeKind" ADD VALUE IF NOT EXISTS 'VISA_EXEMPT';
