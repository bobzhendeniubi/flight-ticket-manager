/**
 * 后台 e2e 公共件：登录、控制台噪音收集、直连 API 的备料通道。
 *
 * 「能用 UI 就用 UI」是主链的原则；这里的 API 通道只留给
 * 拖拽分房这类在无头浏览器里天生脆的动作——用 API 落数据，回 UI 断言。
 */
import { expect, type APIRequestContext, type Page, type Response } from '@playwright/test';
import { API_URL } from './e2e-env';

/** seed 里的运营全权限账号（backend/prisma/seed.ts）。 */
export const ADMIN_EMAIL = 'admin@ftm.local';
export const ADMIN_PASSWORD = 'Password123!';

/**
 * 走 UI 登录后台，落在仪表盘。
 *
 * 注意断言必须钉死「仪表盘」这个标题：登录页自己也有一个 h1（「登录」），
 * 只断言「有个 h1」会在登录请求还在飞的时候就立刻通过，后面的 goto 撞上
 * 尚未落盘的会话被 Protected 打回登录页——这个坑踩过一次。
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(ADMIN_EMAIL);
  await page.getByLabel('密码').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: '登录后台' }).click();
  await page.waitForURL('**/dashboard', { timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1, name: '运营仪表盘' })).toBeVisible({
    timeout: 30_000,
  });
}

/** 直连后端拿 access token（备料用；不经前端）。 */
export async function apiLogin(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_URL}/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(res.ok(), `登录接口应成功，实际 ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { tokens: { accessToken: string } };
  return body.tokens.accessToken;
}

/**
 * 已知的无害控制台噪音——只放行「和被测业务无关、且不影响页面可用」的几类：
 * dev 环境的 HMR/websocket、favicon 404、React DevTools 提示。
 * 业务接口报错不在此列，必须让用例红。
 */
const IGNORED_CONSOLE_PATTERNS: RegExp[] = [
  /favicon/i,
  /Download the React DevTools/i,
  /\[vite\]/i,
  /WebSocket connection to .*vite/i,
  /ResizeObserver loop/i,
];

export interface PageNoise {
  /** console.error 文本（已过滤已知噪音）。 */
  consoleErrors: string[];
  /** 状态码 >= 500 的响应，格式 `500 GET /orders`。 */
  serverErrors: string[];
}

/**
 * 挂上 console / response 监听，返回一个持续累积的噪音收集器。
 * 在 page 创建后、第一次 goto 之前调用。
 */
export function collectPageNoise(page: Page): PageNoise {
  const noise: PageNoise = { consoleErrors: [], serverErrors: [] };

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED_CONSOLE_PATTERNS.some((re) => re.test(text))) return;
    noise.consoleErrors.push(text);
  });

  page.on('response', (res: Response) => {
    if (res.status() < 500) return;
    noise.serverErrors.push(`${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}`);
  });

  return noise;
}

/** 清空收集器（逐页断言时，每页开始前调一次，报错信息才不会串页）。 */
export function resetNoise(noise: PageNoise): void {
  noise.consoleErrors.length = 0;
  noise.serverErrors.length = 0;
}

/** 每轮跑用唯一后缀，避免和历史数据 / 重复乘客闸互相干扰。 */
export function runTag(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
}

/** `YYYY-MM-DD`。 */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 今天 + n 天的 `YYYY-MM-DD`。 */
export function daysFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return isoDate(d);
}
