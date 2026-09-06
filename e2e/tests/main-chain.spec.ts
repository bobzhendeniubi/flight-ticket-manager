/**
 * 主链：录单 → 认款 → 签证 → 分房 → 出票标记 → 拆单 → 换人 → 取消。
 *
 * 一条用例走完一张套餐单的完整生命周期，每步都在 UI 上断言关键文案/状态。
 * 只有分房走 API（拖拽在无头浏览器里天生脆），落库后仍回 UI 断言房间里站着谁。
 * 拆单前后另做一次金额守恒断言：应收/已收合计不能因为拆单凭空多出或少掉。
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { API_URL } from '../support/e2e-env';
import { apiLogin, daysFromToday, loginAsAdmin, runTag } from '../support/admin-console';

/** seed 里唯一的示例套餐（backend/prisma/seed.ts seedBundles）。 */
const BUNDLE_KEYWORD = '凯悦海景';

interface OrderSnapshot {
  id: string;
  orderNumber: string;
  /** 应收（客户实际应付，含售后调整）。 */
  payable: number;
  /** 已收。 */
  paid: number;
  passengerIds: string[];
}

/** 按订单号查订单（备料 / 金额守恒断言用，不经前端）。 */
async function fetchOrder(
  request: APIRequestContext,
  token: string,
  orderNumber: string,
): Promise<OrderSnapshot> {
  const res = await request.get(`${API_URL}/orders/`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { search: orderNumber, pageSize: '50' },
  });
  expect(res.ok(), `查订单 ${orderNumber} 应成功，实际 ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { orders: Array<Record<string, unknown>> };
  const summary = body.orders.find((o) => o.orderNumber === orderNumber);
  expect(summary, `列表里应能查到订单 ${orderNumber}`).toBeTruthy();

  const detailRes = await request.get(`${API_URL}/orders/${String(summary!.id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(detailRes.ok(), `订单详情 ${orderNumber} 应成功`).toBeTruthy();
  const detail = ((await detailRes.json()) as { order: Record<string, unknown> }).order;

  return {
    id: String(detail.id),
    orderNumber: String(detail.orderNumber),
    // effectivePayable 是后端权威的「应收」口径（total + 售后调整）；老字段 total 兜底
    payable: Number(detail.effectivePayable ?? detail.total ?? 0),
    paid: Number(detail.paidAmount ?? 0),
    passengerIds: Array.isArray(detail.passengers)
      ? (detail.passengers as Array<{ id: string }>).map((p) => p.id)
      : [],
  };
}

/** 一位出行人的录入数据。 */
interface PaxInput {
  fullName: string;
  documentNumber: string;
  dateOfBirth: string;
  gender: 'M' | 'F';
  passportExpiry: string;
}

/** 在录单弹窗里填第 index 位出行人（index 从 0 起）。 */
async function fillPassenger(dialog: Locator, index: number, pax: PaxInput): Promise<void> {
  // 标签都是包裹式 <label>文案<input/></label>，getByLabel 能直接拿到控件；
  // 用 /^姓名/ 这类前缀正则把「姓名」和「中文姓名（选填）」区分开。
  await dialog.getByLabel(/^姓名/).nth(index).fill(pax.fullName);
  await dialog.getByLabel(/^性别/).nth(index).selectOption(pax.gender);
  await dialog.getByLabel(/^护照号/).nth(index).fill(pax.documentNumber);
  await dialog.getByLabel(/^出生日期/).nth(index).fill(pax.dateOfBirth);
  await dialog.getByLabel(/^护照有效期/).nth(index).fill(pax.passportExpiry);
}

/** 从「录单成功 · 订单号 XXX」横幅里取订单号。 */
async function readCreatedOrderNumber(dialog: Locator): Promise<string> {
  const banner = dialog.getByText('录单成功');
  await expect(banner).toBeVisible();
  const text = (await banner.innerText()).trim();
  const matched = /订单号\s*([A-Za-z0-9-]+)/.exec(text);
  expect(matched, `应能从「${text}」里解析出订单号`).toBeTruthy();
  return matched![1];
}

/** 打开订单详情抽屉（列表里订单号本身就是按钮）。 */
async function openOrderDetail(page: Page, orderNumber: string): Promise<Locator> {
  await page.goto('/orders');
  const searchBox = page.getByPlaceholder('如 FTM2026 / 张伟 / E12345678 / 总代');
  await searchBox.fill(orderNumber);
  await page.getByRole('button', { name: orderNumber, exact: true }).first().click();
  const detail = page.getByRole('dialog', { name: '订单详情' });
  await expect(detail).toBeVisible();
  return detail;
}

/**
 * 若弹出了全站统一的二次确认框（ConfirmDialog：取消 / 确认），点「确认」。
 * 没弹就直接放行——好几个动作是「有条件才二次确认」，写死等确认会假红。
 */
async function acceptConfirmIfShown(page: Page, timeout = 3_000): Promise<boolean> {
  const confirmButton = page.getByRole('button', { name: '确认', exact: true });
  try {
    await confirmButton.waitFor({ state: 'visible', timeout });
  } catch {
    return false;
  }
  await confirmButton.click();
  return true;
}

/** 关闭订单详情抽屉。 */
async function closeOrderDetail(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '订单详情' })).toBeHidden();
}

test.describe('后台主链', () => {
  test('套餐单走完 录单→认款→签证→分房→出票→拆单→换人→取消', async ({ page, request }) => {
    const tag = runTag();
    const departDate = daysFromToday(30);
    const passportExpiry = daysFromToday(365 * 5);
    const paxA: PaxInput = {
      fullName: `E2EALPHA ${tag}`,
      documentNumber: `EA${tag}`,
      dateOfBirth: '1990-01-01',
      gender: 'M',
      passportExpiry,
    };
    const paxB: PaxInput = {
      fullName: `E2EBRAVO ${tag}`,
      documentNumber: `EB${tag}`,
      dateOfBirth: '1992-02-02',
      gender: 'F',
      passportExpiry,
    };

    const token = await apiLogin(request);
    let orderNumber = '';

    await test.step('① 运营登录后台', async () => {
      await loginAsAdmin(page);
    });

    await test.step('② 录单：套餐 + 2 位出行人', async () => {
      await page.goto('/orders');
      await page.getByRole('button', { name: '＋ 录单' }).click();

      const dialog = page.getByRole('dialog', { name: '录单' });
      await expect(dialog.getByRole('heading', { name: '手工录单（一单可含多个产品）' })).toBeVisible();

      // 产品类型切到「套餐」
      await dialog.getByRole('button', { name: '套餐', exact: true }).click();

      // 套餐是可搜索下拉：聚焦展开 → 输入关键字 → 点选项
      const bundlePicker = dialog.getByPlaceholder('搜索套餐（编号 / 名称）…');
      await bundlePicker.click();
      await bundlePicker.fill(BUNDLE_KEYWORD);
      await dialog.getByRole('button', { name: new RegExp(BUNDLE_KEYWORD) }).first().click();

      await dialog.getByLabel('出发日期').fill(departDate);
      await dialog.getByLabel('成人', { exact: false }).first().fill('2');

      // 默认只有 1 位出行人，补第 2 位
      await dialog.getByRole('button', { name: '＋ 加一位' }).click();
      await fillPassenger(dialog, 0, paxA);
      await fillPassenger(dialog, 1, paxB);

      await dialog.getByRole('button', { name: '提交录单' }).click();

      orderNumber = await readCreatedOrderNumber(dialog);
      expect(orderNumber, '订单号不应为空').not.toEqual('');

      await dialog.getByRole('button', { name: '完成' }).click();
      await expect(dialog).toBeHidden();
    });

    await test.step('③ 认款：全额确认收款，尾款变「已结清」', async () => {
      const detail = await openOrderDetail(page, orderNumber);

      // 收款金额默认已预填成尾款全额（ConfirmPaymentSection 的 setAmount(due)），
      // 所以正常路径不弹二次确认；留空提交或重复同额才会弹，这里兼容两种。
      await detail.getByRole('button', { name: '确认收款' }).click();
      await acceptConfirmIfShown(page);

      await expect(detail.getByText('已结清').first()).toBeVisible();
      await closeOrderDetail(page);
    });

    await test.step('④ 签证台：批量标「已送签」', async () => {
      await page.goto('/visa-desk');
      await page.getByPlaceholder('姓名 / 护照号…').fill(tag);

      // 订单级复选框：一次勾中该单全部乘客，避免逐人匹配展示名
      await page.getByLabel(`选择订单 ${orderNumber} 全部乘客`).check();

      // 批量目标默认就是「已送签」(CONFIRMED)，直接执行
      await page.getByRole('button', { name: /^执行/ }).click();
      await acceptConfirmIfShown(page, 10_000);

      await expect(page.getByText('已送签').first()).toBeVisible();
    });

    await test.step('⑤ 订单头自动变「已签证」', async () => {
      const detail = await openOrderDetail(page, orderNumber);
      await expect(detail.getByText('签证：已签证')).toBeVisible();
      await closeOrderDetail(page);
    });

    await test.step('⑥ 分房：API 落两人同房，UI 断言房间里站着这两位', async () => {
      const snapshot = await fetchOrder(request, token, orderNumber);
      expect(snapshot.passengerIds.length, '订单应有 2 位乘客').toBe(2);

      const res = await request.put(`${API_URL}/orders/${snapshot.id}/room-assignment`, {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          roomGroups: [
            {
              id: 'e2e-room-1',
              hotelName: '岘港凯悦度假村',
              roomType: '海景大床房',
              passengerIds: snapshot.passengerIds,
            },
          ],
        },
      });
      expect(res.ok(), `分房接口应成功，实际 ${res.status()} ${await res.text()}`).toBeTruthy();

      const detail = await openOrderDetail(page, orderNumber);
      await detail.getByRole('button', { name: '调整分房' }).click();
      const rooming = page.getByRole('dialog', { name: '分房编辑' });
      await expect(rooming.getByText('房间 1')).toBeVisible();
      await expect(rooming.getByText(paxA.fullName)).toBeVisible();
      await expect(rooming.getByText(paxB.fullName)).toBeVisible();
      await rooming.getByRole('button', { name: '取消' }).click();
      await closeOrderDetail(page);
    });

    await test.step('⑦ 出票标记：去程/回程/系统 三个维度都点成「已开」', async () => {
      const detail = await openOrderDetail(page, orderNumber);
      for (const dimension of ['去程', '回程', '系统']) {
        await detail.getByRole('button', { name: `${dimension}：未开` }).click();
        await expect(detail.getByRole('button', { name: `${dimension}：已开` })).toBeVisible();
      }
      await closeOrderDetail(page);
    });

    let splitOrderNumber = '';
    await test.step('⑧ 拆单：拆出 1 人，且拆单前后金额守恒', async () => {
      const before = await fetchOrder(request, token, orderNumber);

      const detail = await openOrderDetail(page, orderNumber);
      await detail.getByRole('button', { name: '拆单（拆出部分乘客）' }).click();

      const splitModal = page.getByRole('dialog', { name: new RegExp(`拆单 · ${orderNumber}`) });
      await expect(splitModal).toBeVisible();
      await splitModal.getByRole('checkbox', { name: new RegExp(paxB.fullName) }).check();

      // 步骤⑥ 把两人分进了同一个房组，拆单预览会报「同房组同时含拆出与留下的乘客」并禁用下一步。
      // 勾上自动劈半组的选项放行（顺带覆盖到半间房这条路径）。
      // 预览是勾人之后异步拉的，这个复选框要等预览回来才渲染——必须显式等，不能立刻 count()。
      const autoSplitRooms = splitModal.getByRole('checkbox', {
        name: /自动把同房组按人劈成两个半组/,
      });
      await autoSplitRooms.waitFor({ state: 'visible' });
      await autoSplitRooms.check();

      await splitModal.getByRole('button', { name: '下一步：确认拆单' }).click();
      await splitModal.getByRole('button', { name: '确认拆单（不可撤销）' }).click();

      await expect(splitModal.getByText('拆单完成')).toBeVisible();
      const doneText = await splitModal.getByText('已拆出').innerText();
      splitOrderNumber = /新订单\s*([A-Za-z0-9-]+)/.exec(doneText)?.[1] ?? '';
      expect(splitOrderNumber, `应能从「${doneText}」里解析出新订单号`).not.toEqual('');
      // 弹层壳自带一个 aria-label="关闭" 的右上角叉，正文底部也有一个「关闭」按钮 —— 取后者
      await splitModal.getByRole('button', { name: '关闭' }).last().click();
      await closeOrderDetail(page);

      // 金额守恒：拆单只是把钱和人分到两张单上，合计不该变
      const afterOrigin = await fetchOrder(request, token, orderNumber);
      const afterSplit = await fetchOrder(request, token, splitOrderNumber);
      expect(afterOrigin.payable + afterSplit.payable, '拆单前后「应收」合计应不变').toBeCloseTo(
        before.payable,
        2,
      );
      expect(afterOrigin.paid + afterSplit.paid, '拆单前后「已收」合计应不变').toBeCloseTo(
        before.paid,
        2,
      );
    });

    const paxC: PaxInput = {
      fullName: `E2ECHARLIE ${tag}`,
      documentNumber: `EC${tag}`,
      dateOfBirth: '1988-03-03',
      gender: 'M',
      passportExpiry,
    };
    await test.step('⑨ 换人：把留在原单的出行人换成新的人', async () => {
      const detail = await openOrderDetail(page, orderNumber);
      await detail.getByRole('button', { name: '换人', exact: true }).first().click();

      // 换人表单就地替换乘客卡片，标题是普通 div（不是 heading）；
      // 订单详情里「保存」按钮不止一个，用 testid 圈住这张表单再找控件。
      const swapForm = detail.getByTestId('passenger-edit-form');
      await expect(swapForm.getByText(/^换人 · /)).toBeVisible();
      await swapForm.getByLabel('全名', { exact: false }).fill(paxC.fullName);
      await swapForm.getByLabel(/^护照号/).fill(paxC.documentNumber);
      await swapForm.getByLabel(/^出生日期/).fill(paxC.dateOfBirth);
      await swapForm.getByLabel(/^护照有效期/).fill(paxC.passportExpiry);

      await swapForm.getByRole('button', { name: '保存', exact: true }).click();
      await acceptConfirmIfShown(page, 10_000);

      // 详情里同名文本有隐藏副本（导出/打印用），只认可见的那些
      await expect(detail.getByText(paxC.fullName).filter({ visible: true }).first()).toBeVisible();
      // 换人 = 顶掉原来的人，不是多加一位
      await expect(detail.getByText(paxA.fullName).filter({ visible: true })).toHaveCount(0);
      await closeOrderDetail(page);
    });

    await test.step('⑩ 取消：整单发起退款申请，状态转「退款申请中」', async () => {
      // 退款理由走的是原生 window.prompt，必须挂 dialog 处理器，否则被自动 dismiss
      page.on('dialog', (dialog) => {
        void dialog.accept('e2e 主链回归：整单退款');
      });

      const detail = await openOrderDetail(page, orderNumber);
      // 「状态流转」默认收在 <details> 里，先展开
      await detail.getByText('更多操作（状态流转）').click();
      await detail.getByRole('button', { name: '申请退款' }).click();

      await expect(detail.getByText('退款申请中').filter({ visible: true }).first()).toBeVisible();
      // UI 徽标之外再核一次后端状态，确认真的落了退款申请而不是只改了个文案
      const cancelled = await request.get(`${API_URL}/orders/${(await fetchOrder(request, token, orderNumber)).id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const cancelledOrder = ((await cancelled.json()) as { order: { status: string } }).order;
      expect(cancelledOrder.status, '订单状态应为 REFUND_REQUESTED').toBe('REFUND_REQUESTED');
    });
  });
});
