-- 慢查询 Top 榜（pg_stat_statements）。用法（实测；测试把 prod 换成 staging）：
--   docker exec -i ftm-postgres-prod psql -U ftm -d ftm < /opt/ftm/infra/staging/pg-top-sql.sql
-- 前提：postgres 带 shared_preload_libraries=pg_stat_statements 启动，且 Prisma 迁移已建扩展
-- （docs/运维-监控与备份.md「pg_stat_statements」）。统计从上次重置 / postgres 重启起累计，
-- SQL 里的常量已被抽成 $1、$2，不含客人数据。
-- 每晚备份的 pg_dump 会对每张表跑一次 COPY … TO stdout，总耗时 / 读盘一定排前面，下面①③把它剔掉。
\pset pager off
\pset null '-'

\echo '== 统计区间（从这个时间点累计到现在）=='
SELECT stats_reset AS 统计起点, dealloc AS 因条目满被挤掉的次数
FROM pg_stat_statements_info;

\echo '== ① 总耗时 Top 20：最该优化的（调用多 × 单次慢）=='
SELECT round(total_exec_time::numeric / 1000, 1) AS 总耗时秒,
       round((100 * total_exec_time / nullif(sum(total_exec_time) OVER (), 0))::numeric, 1) AS 占比pct,
       calls AS 调用次数,
       round(mean_exec_time::numeric, 1) AS 平均ms,
       round(max_exec_time::numeric, 1) AS 最慢ms,
       rows AS 返回行数,
       left(regexp_replace(query, '\s+', ' ', 'g'), 200) AS sql
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND query !~* '^COPY .* TO stdout'
ORDER BY total_exec_time DESC
LIMIT 20;

\echo '== ② 单次平均最慢 Top 20（至少调用 5 次，排除偶发）=='
SELECT round(mean_exec_time::numeric, 1) AS 平均ms,
       round(max_exec_time::numeric, 1) AS 最慢ms,
       calls AS 调用次数,
       round((rows::numeric / nullif(calls, 0)), 1) AS 平均返回行,
       left(regexp_replace(query, '\s+', ' ', 'g'), 200) AS sql
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND calls >= 5
ORDER BY mean_exec_time DESC
LIMIT 20;

\echo '== ③ 读盘最多 Top 10（缓存命中率低 → 缺索引 / 扫大表 / 内存不够）=='
SELECT shared_blks_read AS 读盘块数,
       round((100.0 * shared_blks_hit / nullif(shared_blks_hit + shared_blks_read, 0))::numeric, 1) AS 缓存命中pct,
       calls AS 调用次数,
       round(mean_exec_time::numeric, 1) AS 平均ms,
       left(regexp_replace(query, '\s+', ' ', 'g'), 200) AS sql
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND query !~* '^COPY .* TO stdout'
ORDER BY shared_blks_read DESC
LIMIT 10;

-- 优化上线后想从零看效果：SELECT pg_stat_statements_reset();
