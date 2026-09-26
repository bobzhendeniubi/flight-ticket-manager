-- 模糊搜索（ILIKE '%词%'）的 GIN 三元组索引。
--
-- 用到这些列的查询：订单列表「乘客姓名」贴名单筛选（fullName / chineseName / formerIdentities）、
-- 订单搜索框（再加 documentNumber 与订单项 description）、签证台客人搜索（fullName / chineseName /
-- documentNumber）。此前全部是整表扫 + 逐行 lower() 比对：乘客表每搜一个词要扫一遍，订单项表
-- 两万行每个搜索词也要扫一遍；列表的取数与计数、分销统计卡片各扫一次。
--
-- 三个字及以上的词（完整中文名、拼音、护照号片段）走索引；两个字的词抽不出完整三元组，
-- 规划器照旧整表扫，结果不受影响。
--
-- pg_trgm 是 PostgreSQL contrib 自带扩展（官方 postgres:16-alpine 镜像已包含），且属于可信扩展，
-- 库属主即可创建。扩展只在迁移里建，不在 schema.prisma 里声明（本项目未开 postgresqlExtensions）；
-- 索引本身在 schema.prisma 里用 type: Gin + ops: raw("gin_trgm_ops") 声明，与迁移同名，免得
-- migrate diff 把它们当成漂移删掉。
--
-- 写放大：GIN 默认 fastupdate，新行先进待合并列表、由 autovacuum 批量合并；乘客表日增几百行、
-- 订单项日增一千来行，可忽略。表都是万行级，建索引秒级完成（持锁期间阻塞写入，时间同量级）。
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "Passenger_fullName_trgm_idx" ON "Passenger" USING GIN ("fullName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Passenger_chineseName_trgm_idx" ON "Passenger" USING GIN ("chineseName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Passenger_formerIdentities_trgm_idx" ON "Passenger" USING GIN ("formerIdentities" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Passenger_documentNumber_trgm_idx" ON "Passenger" USING GIN ("documentNumber" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "OrderItem_description_trgm_idx" ON "OrderItem" USING GIN ("description" gin_trgm_ops);
