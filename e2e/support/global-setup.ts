/**
 * Playwright 全局 setup：把 e2e 库刷成一个已知的干净起点。
 *
 * 顺序：护栏（库名必须含 e2e / test）→ prisma migrate deploy → seed。
 * seed 本身幂等（全是 upsert），所以重复跑不会炸；主链用例再靠「每轮唯一的乘客名」
 * 把自己和历史数据隔开，不需要 truncate 整库。
 */
import { execFileSync } from 'node:child_process';
import { BACKEND_DIR, databaseNameOf, redactDatabaseUrl, resolveE2eDatabaseUrl } from './e2e-env';

function run(label: string, args: string[], databaseUrl: string): void {
  const startedAt = Date.now();
  process.stdout.write(`[e2e setup] ${label}…\n`);
  execFileSync('npx', args, {
    cwd: BACKEND_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DATABASE_URL: databaseUrl,
    },
  });
  process.stdout.write(`[e2e setup] ${label} 完成（${Date.now() - startedAt}ms）\n`);
}

export default function globalSetup(): void {
  // 护栏在最前面：库名不含 e2e / test 就直接抛错，后面的迁移和 seed 一步都不会跑。
  const databaseUrl = resolveE2eDatabaseUrl();

  process.stdout.write(
    `[e2e setup] 目标库 ${databaseNameOf(databaseUrl)}（${redactDatabaseUrl(databaseUrl)}）\n`,
  );

  run('prisma migrate deploy', ['prisma', 'migrate', 'deploy'], databaseUrl);
  run('prisma seed', ['tsx', 'prisma/seed.ts'], databaseUrl);
}
