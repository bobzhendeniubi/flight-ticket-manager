import { defineConfig, devices } from '@playwright/test';
import {
  ADMIN_WEB_DIR,
  API_PORT,
  API_URL,
  BACKEND_DIR,
  BASE_URL,
  WEB_PORT,
  backendServerEnv,
  resolveE2eDatabaseUrl,
} from './support/e2e-env';

/**
 * e2e 只跑 chromium。用例串行（workers: 1）——主链是一条有状态的链，
 * 而且后端库是共享的，并行只会互相踩。
 *
 * 后端用 `tsx src/index.ts` 直接起（不是 `npm run dev` 的 tsx watch）：
 * 同样是 ~3 秒冷启，但没有文件监听，不会在跑用例中途因为编辑器保存而重启。
 */

// 护栏前置：库名不含 e2e / test 时，这里就抛错，连 --list 都跑不起来。
const databaseUrl = resolveE2eDatabaseUrl();

export default defineConfig({
  testDir: './tests',
  // 主链一步接一步，单条用例给足时间（录单 + 8 个后续动作）
  timeout: 180_000,
  // 冷启的 vite dev 要现编 OrdersPage.tsx（1.8 万行 / 超过 babel 500KB 阈值），
  // 首次打开订单页可以慢到十几秒——超时给宽一点，免得把「慢」误报成「坏」。
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['github']]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  globalSetup: './support/global-setup',

  webServer: [
    {
      command: 'npx tsx src/index.ts',
      cwd: BACKEND_DIR,
      url: `${API_URL}/healthz`,
      env: backendServerEnv(databaseUrl),
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      cwd: ADMIN_WEB_DIR,
      url: BASE_URL,
      env: {
        ...(process.env as Record<string, string>),
        VITE_DEV_PORT: String(WEB_PORT),
        VITE_DEV_API_TARGET: `http://127.0.0.1:${API_PORT}`,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
