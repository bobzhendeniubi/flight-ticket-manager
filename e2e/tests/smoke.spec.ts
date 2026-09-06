/**
 * 页面冒烟：运营账号登录后逐个打开 12 个主要页面。
 *
 * 断言三件事：主标题可见、没有 console error、没有 5xx 响应。
 * 这条用例专治「前端类问题只能靠人眼冒烟」——白屏、路由挂了、接口 500 都会红。
 */
import { expect, test } from '@playwright/test';
import { collectPageNoise, loginAsAdmin, resetNoise } from '../support/admin-console';

/** 12 个主要页面：路径 + 页面 h1 文案（h1 见各 page 组件）。 */
const PAGES: ReadonlyArray<{ path: string; heading: string; label: string }> = [
  { path: '/orders', heading: '订单管理', label: '订单' },
  { path: '/flights', heading: '航班管理', label: '航班' },
  { path: '/products', heading: '产品管理', label: '产品' },
  { path: '/hotel-control', heading: '房控', label: '房控' },
  { path: '/visa-desk', heading: '签证台', label: '签证台' },
  { path: '/hold-orders', heading: '占位单管理', label: '占位单' },
  { path: '/reconciliation', heading: '收款对账台', label: '对账台' },
  { path: '/finances', heading: '财务', label: '财务' },
  { path: '/reports', heading: '经营报表', label: '报表' },
  { path: '/reminders', heading: '提醒中心', label: '提醒' },
  { path: '/agents', heading: '代理管理', label: '代理' },
  { path: '/settings/ai-ocr', heading: 'AI 识别设置', label: '设置' },
];

test.describe('后台页面冒烟', () => {
  test('运营账号登录后 12 个主要页面都能打开且无报错', async ({ page }) => {
    const noise = collectPageNoise(page);

    await loginAsAdmin(page);

    for (const target of PAGES) {
      await test.step(`${target.label}（${target.path}）`, async () => {
        resetNoise(noise);

        await page.goto(target.path);

        // 主标题可见 = 路由命中且组件渲染出来了（白屏会在这里红）
        await expect(
          page.getByRole('heading', { level: 1, name: target.heading }),
          `${target.path} 应显示主标题「${target.heading}」`,
        ).toBeVisible();

        // 首屏接口大多在挂载后才发；给它们一点时间落地再判噪音
        await page.waitForLoadState('networkidle');

        expect(noise.serverErrors, `${target.path} 不应有 5xx 响应`).toEqual([]);
        expect(noise.consoleErrors, `${target.path} 不应有 console error`).toEqual([]);
      });
    }
  });
});
