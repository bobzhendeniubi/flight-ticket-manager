/**
 * 集成测试 vitest 配置
 *
 * - 只跑 *.integration.test.ts 文件（默认 npm test 不跑，build-and-test 主干闸不需要 DB）
 * - 启动时自动 prisma migrate deploy 到 TEST_DATABASE_URL
 * - 每个 test file 之前 truncate 所有表（保证测试隔离）
 * - 串行（pool=forks, singleFork）— Prisma client 共享 schema，并行写会冲突
 *
 * CI：.github/workflows/ci.yml 里独立的 integration job（与 build-and-test 并行）
 * 用 postgres:16 + redis service 容器跑这套；本地跑法一致：
 *   1. docker compose -f ../docker-compose.test.yml up -d
 *   2. npm run test:integration
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    setupFiles: ['./tests/integration/setup.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true, // 串行：避免 prisma client + 共享表冲突
      },
    },
    testTimeout: 30000, // DB 操作偶尔慢，给 30s
    hookTimeout: 60000, // setupFiles 跑 prisma migrate 可能 30s+
  },
});
