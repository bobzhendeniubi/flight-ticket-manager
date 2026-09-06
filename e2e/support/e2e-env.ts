/**
 * e2e 运行环境解析 + **数据库护栏**。
 *
 * 全局 setup 会对 DATABASE_URL 指向的库跑 migrate deploy + seed（写操作），
 * 所以这里必须先把「这是不是一个可以随便折腾的库」判死：
 * 库名不含 e2e / test 就直接抛错退出，绝不允许 e2e 碰实测库或本地主开发库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根目录（e2e/support → e2e → repo root）。 */
export const REPO_ROOT = path.resolve(here, '..', '..');
export const BACKEND_DIR = path.join(REPO_ROOT, 'backend');
export const ADMIN_WEB_DIR = path.join(REPO_ROOT, 'admin-web');

/** 端口：默认避开日常开发用的 4000 / 5174，免得 e2e 和同事的 dev server 抢端口。 */
export const API_PORT = Number(process.env.E2E_API_PORT || 4801);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT || 5874);

/** vite dev server 只监听 localhost（macOS 上是 ::1），baseURL 必须用 localhost 而不是 127.0.0.1。 */
export const BASE_URL = process.env.E2E_BASE_URL || `http://localhost:${WEB_PORT}`;
export const API_URL = process.env.E2E_API_URL || `http://127.0.0.1:${API_PORT}`;

/** 库名里出现这些片段才认为是「可销毁的测试库」。 */
const DISPOSABLE_DB_NAME = /(e2e|test)/i;

/** 从 backend/.env 里捞一个 key（e2e 不引 dotenv，够用就行）。 */
function readFromBackendEnvFile(key: string): string | undefined {
  const envPath = path.join(BACKEND_DIR, '.env');
  if (!fs.existsSync(envPath)) return undefined;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    return line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return undefined;
}

/** 从连接串里取库名（去掉 query）。解析失败返回 null。 */
export function databaseNameOf(databaseUrl: string): string | null {
  try {
    const name = new URL(databaseUrl).pathname.replace(/^\//, '');
    return name || null;
  } catch {
    return null;
  }
}

/** 打日志用：把连接串里的账号密码抹掉。 */
export function redactDatabaseUrl(databaseUrl: string): string {
  return databaseUrl.replace(/\/\/[^@/]*@/, '//***@');
}

/**
 * 解析 e2e 要用的 DATABASE_URL，并**强制**通过测试库护栏。
 *
 * 取值优先级：E2E_DATABASE_URL > backend/.env 的 DATABASE_URL。
 * 库名不含 e2e / test 一律抛错——宁可让 e2e 跑不起来，也不能把实测库 seed 掉。
 */
export function resolveE2eDatabaseUrl(): string {
  const databaseUrl = process.env.E2E_DATABASE_URL?.trim() || readFromBackendEnvFile('DATABASE_URL');

  if (!databaseUrl) {
    throw new Error(
      'e2e 找不到 DATABASE_URL：请设置 E2E_DATABASE_URL，或在 backend/.env 里配一个指向测试库的 DATABASE_URL。\n' +
        '例：E2E_DATABASE_URL=postgresql://ftm:ftm_dev_password@127.0.0.1:5432/ftm_e2e?schema=public',
    );
  }

  const dbName = databaseNameOf(databaseUrl);
  if (!dbName) {
    throw new Error(`e2e 拒绝执行：DATABASE_URL 解析不出库名（${redactDatabaseUrl(databaseUrl)}）。`);
  }
  if (!DISPOSABLE_DB_NAME.test(dbName)) {
    throw new Error(
      `e2e 拒绝执行：目标库「${dbName}」的库名不含 e2e / test。\n` +
        'e2e 全局 setup 会对这个库跑 migrate deploy + seed（写操作），只允许对一次性测试库执行。\n' +
        '请先建一个测试库并指过去，例如：\n' +
        '  createdb -h 127.0.0.1 -O ftm ftm_e2e\n' +
        '  export E2E_DATABASE_URL=postgresql://ftm:ftm_dev_password@127.0.0.1:5432/ftm_e2e?schema=public',
    );
  }

  return databaseUrl;
}

/** 后端子进程的环境：注入 e2e 库和端口（dotenv 默认不覆盖已存在的 process.env，所以这里会赢过 backend/.env）。 */
export function backendServerEnv(databaseUrl: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    NODE_ENV: 'development',
    DATABASE_URL: databaseUrl,
    PORT: String(API_PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
  };
}
