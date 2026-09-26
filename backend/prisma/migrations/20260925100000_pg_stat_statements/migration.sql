-- 慢查询可观测：启用 pg_stat_statements（按 SQL 形状累计调用次数 / 总耗时 / 平均耗时 / 返回行数）。
--
-- 只建扩展，不动任何业务表。真正采集要靠 postgres 启动参数
-- shared_preload_libraries=pg_stat_statements（docker-compose.prod.yml 的 postgres.command），
-- 那一步需要单独重建 postgres 容器，见 docs/运维-监控与备份.md。
-- 没预加载时建扩展照样成功，只是查视图会报「must be loaded via shared_preload_libraries」，不影响业务。
--
-- 为什么包一层判断而不是裸写 CREATE EXTENSION：pg_stat_statements 不是 trusted 扩展，只有超级用户能建。
-- 线上 / 测试容器里 ftm 是超级用户（官方镜像的 POSTGRES_USER 默认就是），会正常建上；
-- 本机 brew Postgres 的 ftm 角色不是超级用户，裸写会让这条迁移直接失败，本地 migrate deploy 和
-- 集成测试全挂。所以「已建 / 没装 contrib / 非超级用户」三种情况都只打 NOTICE 跳过。
--
-- 不在 schema.prisma 里声明扩展（没开 postgresqlExtensions 预览特性，与 btree_gist 的做法一致）。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_stat_statements') THEN
    RAISE NOTICE 'pg_stat_statements 未安装（缺 contrib 包），跳过；只影响慢查询统计';
    RETURN;
  END IF;

  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE NOTICE '当前角色 % 不是超级用户，跳过 pg_stat_statements；只影响慢查询统计', current_user;
    RETURN;
  END IF;

  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
END
$$;
