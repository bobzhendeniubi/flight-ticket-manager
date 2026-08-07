// 0806 手册截图：登录 staging 后台，逐页截图（best-effort，单页失败不影响其它）
import { chromium } from '/Users/bobwang/.claude/skills/gstack/node_modules/playwright/index.mjs';

const BASE = 'https://admin.citurtravel.com';
const OUT = process.argv[2];
const results = [];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

async function shot(name, fn) {
  try { await fn(); await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    results.push(`OK ${name}`);
  } catch (e) { results.push(`FAIL ${name}: ${String(e).slice(0,120)}`); }
}

// 登录
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#email, input[type="email"]', 'admin@ftm.local');
await page.fill('#password, input[type="password"]', 'Password123!');
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard|orders/, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);

// 1 房控·销控矩阵（聚合组）
await shot('01-销控矩阵', async () => {
  await page.goto(`${BASE}/hotel-control`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
});
// 2 房控·包房周期管理（滚到该区）
await shot('02-包房周期管理', async () => {
  const el = page.locator('text=包房周期').first();
  await el.scrollIntoViewIfNeeded();
});
// 3 订单页·批量创单弹窗
await shot('03-批量创单', async () => {
  await page.goto(`${BASE}/orders`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.click('text=＋ 批量创单');
  await page.waitForTimeout(1500);
});
// 4 订单页·批量条（勾选第一单）
await shot('04-批量条', async () => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  const cb = page.locator('tbody input[type="checkbox"]').first();
  await cb.check();
  await page.waitForTimeout(800);
  const bar = page.locator('text=已选').first();
  await bar.scrollIntoViewIfNeeded();
});
// 5 签证台
await shot('05-签证台', async () => {
  await page.goto(`${BASE}/visa-desk`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const cb = page.locator('input[type="checkbox"]').first();
  await cb.check().catch(() => {});
  await page.waitForTimeout(800);
});
// 6 财务·汇率卡
await shot('06-财务汇率', async () => {
  await page.goto(`${BASE}/finances`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const el = page.locator('text=美金汇率').first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
});
// 7 结算价·机票页签
await shot('07-机票结算价', async () => {
  await page.goto(`${BASE}/settlement-rates`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.click('text=机票结算价');
  await page.waitForTimeout(2000);
});
// 8 产品·签证加急档位（打开第一个签证的编辑）
await shot('08-签证加急档位', async () => {
  await page.goto(`${BASE}/products`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.click('text=签证');
  await page.waitForTimeout(1000);
  await page.locator('text=编辑').first().click();
  await page.waitForTimeout(1000);
  const el = page.locator('text=加急档位').first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
});
// 9 产品·酒店国际五星（新增酒店弹窗）
await shot('09-酒店国际五星', async () => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await page.locator('text=酒店').first().click();
  await page.waitForTimeout(800);
  await page.locator('button:has-text("新增")').first().click().catch(async () => {
    await page.locator('text=新建').first().click();
  });
  await page.waitForTimeout(800);
});
console.log(results.join('\n'));
await browser.close();
