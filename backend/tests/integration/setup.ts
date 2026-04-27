/**
 * 集成测试启动脚本（vitest setupFiles）
 *
 * - 检查 TEST_DATABASE_URL（默认指向 docker-compose.test.yml 的 ftm_test:55432）
 * - 把 DATABASE_URL 临时切换到 TEST_DATABASE_URL，让 backend 里 import { prisma } 都连这边
 * - beforeAll: 跑 prisma migrate deploy 把测试库 schema 同步
 * - beforeEach: TRUNCATE 所有用户表（保留 schema 但清数据，每个测试隔离）
 *
 * 注意：
 *   - 测试库必须已经启动：docker compose -f docker-compose.test.yml up -d
 *   - 不会碰 dev 库（端口 55432 != 5432，db ftm_test != ftm）
 */
import { execSync } from 'node:child_process';
import { beforeAll, beforeEach } from 'vitest';

const DEFAULT_TEST_URL =
  'postgresql://ftm_test:ftm_test@localhost:55432/ftm_test?schema=public';

const testDbUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL;

// 关键：把 DATABASE_URL 改到测试库（在 prisma client 第一次 import 之前）
process.env.DATABASE_URL = testDbUrl;

beforeAll(() => {
  console.log('[integration] Running prisma migrate deploy → test DB…');
  try {
    execSync('npx prisma migrate deploy', {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: testDbUrl },
      cwd: process.cwd(),
    });
  } catch (e) {
    throw new Error(
      `[integration] prisma migrate deploy 失败。请先启动测试 DB：\n` +
        `  docker compose -f docker-compose.test.yml up -d\n` +
        `\n原始错误: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}, 60_000);

// 每个 test 前清空所有用户表（保留 schema）
// TRUNCATE ... CASCADE 一次性清干净，比 deleteMany 快得多
beforeEach(async () => {
  const { prisma } = await import('../../src/db/prisma.js');
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma_%'
  `;
  if (tables.length === 0) return;
  const tableList = tables.map((t) => `"${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
});
