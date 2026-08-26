// 0825 手册截图：本地 dev 后台（localhost:5174）登录后逐页截图（best-effort）。
// 本地测试库有 1100+ 航班，占位单页按航班逐个拉班次会打爆浏览器——
// 这里按 QH9588/QH9589 白名单拦截班次请求，其余直接回空数组。
import { chromium } from '/Users/bobwang/.claude/skills/gstack/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:5174';
const OUT = process.argv[2];
const results = [];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

async function shot(name, fn) {
  try { await fn(); await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    results.push(`OK ${name}`);
  } catch (e) { results.push(`FAIL ${name}: ${String(e).slice(0, 160)}`); }
}

// 登录
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#email, input[type="email"]', 'admin@ftm.local');
await page.fill('#password, input[type="password"]', 'Password123!');
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard|orders/, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);

// 航班班次请求白名单（只放行 QH9588/QH9589 的）
const token = await page.evaluate(() => JSON.parse(localStorage.getItem('ftm-admin-auth')).state.tokens.accessToken);
const flightsRes = await page.request.get(`${BASE}/api/flights`, { headers: { Authorization: `Bearer ${token}` } });
const flights = (await flightsRes.json()).flights ?? [];
const allow = new Set(flights.filter((f) => f.flightNumber === 'QH9588' || f.flightNumber === 'QH9589').map((f) => f.id));
await page.route('**/api/flights/*/schedules*', (route) => {
  const m = /\/api\/flights\/([^/]+)\/schedules/.exec(route.request().url());
  if (m && !allow.has(m[1])) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schedules: [] }) });
  }
  return route.continue();
});

// 1 占位单列表：行操作里的「编辑」入口
await shot('01-占位单列表-编辑入口', async () => {
  await page.goto(`${BASE}/hold-orders`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
});

// 2 占位单编辑弹窗（预填团名/备注）
await shot('02-占位单编辑弹窗', async () => {
  await page.getByText('编辑', { exact: true }).first().click();
  await page.waitForTimeout(1000);
});

// 3 对账台「待核实」页签
await shot('03-对账台待核实页签', async () => {
  await page.keyboard.press('Escape');
  await page.goto(`${BASE}/reconciliation`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.getByText('待核实', { exact: false }).first().click();
  await page.waitForTimeout(1500);
});

// 4 订单页批量条（勾选一单，露出批量改备注/改代理/改航班）
await shot('04-订单批量纠错入口', async () => {
  await page.goto(`${BASE}/orders`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const cb = page.locator('tbody input[type="checkbox"]').first();
  await cb.check();
  await page.waitForTimeout(800);
});

await browser.close();
console.log(results.join('\n'));
