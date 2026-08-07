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
  } catch (e) { results.push(`FAIL ${name}: ${String(e).slice(0,150)}`); }
}
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('input[type="email"]', 'admin@ftm.local');
await page.fill('input[type="password"]', 'Password123!');
await page.click('button[type="submit"]');
await page.waitForTimeout(3000);

// 4 订单批量条
await shot('04-批量条', async () => {
  await page.goto(`${BASE}/orders`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  const cb = page.locator('input[aria-label^="选择订单"]').first();
  await cb.scrollIntoViewIfNeeded();
  await cb.check();
  await page.waitForTimeout(800);
  await page.locator('text=已选').first().scrollIntoViewIfNeeded();
});
// 8 签证加急档位
await shot('08-签证加急档位', async () => {
  await page.goto(`${BASE}/products`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: /签证/ }).first().click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  await page.waitForTimeout(1000);
  const el = page.locator('text=加急档位').first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
});
// 9 酒店国际五星（新增酒店弹窗，展开星级下拉不易截，截表单即可）
await shot('09-酒店国际五星', async () => {
  await page.goto(`${BASE}/products`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: /新增酒店|新建酒店/ }).first().click();
  await page.waitForTimeout(1000);
});
console.log(results.join('\n'));
await browser.close();
