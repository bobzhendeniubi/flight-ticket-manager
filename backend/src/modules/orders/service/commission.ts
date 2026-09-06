// 由 orders.service.ts 机械拆出（审查根因 R5，2026-09-06）：只搬代码、不改口径。
// 对外契约仍从 ../orders.service.js 取（facade 原名再导出）；OrderService 方法体在这里是
// `export function xxx(svc: OrderService, ...)`，方法里的 `this.` 一律写成 `svc.`——
// 跨组调用仍走 facade 实例，单测里对 OrderService 实例的 spy 行为不变。

import {
  AuditSeverity,
  AuditTargetType,
  CommissionStatus,
  OrderItemKind,
  Prisma,
  ProductKind,
} from '@prisma/client';
import { writeAudit } from '../../../lib/audit.js';
import { localToUtc } from '../../../lib/flight-time.js';
import { BUSINESS_TZ } from '../../../lib/business-time.js';
import { deriveOrderDepartDate } from './read.js';
import { round2 } from './shared.js';

// ════════════════════════════════════════════════════════════════════
// 佣金链路计算 — 当订单转 PAID 时调用，为卖家代理 + 所有上级代理创建 CommissionRecord
//
// 级联模型（child rate ≤ parent rate 不变式）：
//   - 卖家代理（链底）拿: seller.rate × baseAmount
//   - 卖家上级拿: (parent.rate - seller.rate) × baseAmount（即 spread）
//   - 再上级拿: (grandparent.rate - parent.rate) × baseAmount
//   - ...一直走到根代理或没规则的代理
//
// 如果某代理对该 productKind 没有 CommissionRule，视作 rate=0（父级会继续"吃"这部分）。
// 每条 OrderItem 单独走一次链路（因为 productKind 可能不同）。
// ════════════════════════════════════════════════════════════════════
// BUNDLE 是独立一档费率，不复用 FLIGHT 档：套餐单会拆成 FLIGHT 腿（机票收入）+ BUNDLE 行
// （地面+加项收入），两行金额相加即全包价、互不重叠，故两者同时计提不构成重复计佣。
// 计佣基数就是 BUNDLE 行自身的 amount，不去拆套餐的组件。
export const ORDER_ITEM_KIND_TO_PRODUCT_KIND: Partial<Record<OrderItemKind, ProductKind>> = {
  FLIGHT: ProductKind.FLIGHT,
  HOTEL: ProductKind.HOTEL,
  TRANSFER: ProductKind.TRANSFER,
  VISA: ProductKind.VISA,
  BUNDLE: ProductKind.BUNDLE,
};

export async function createCommissionsForOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  sellerAgentId: string,
  orderNumber?: string | null,
  // 唯一的行为开关，只为「一次性补提脚本的 dry-run」而存在（见文件末尾的导出说明）：
  // dry-run 会把本函数整段跑在一个**最后回滚掉的事务**里，用回滚后作废的写入换取
  // 「与线上计提逐分钱一致」的预览。但第 4 步的零计提审计走的是全局 prisma（不在 tx 里），
  // 回滚不掉——dry-run 会往审计表里刷一批 COMMISSION_ACCRUAL_EMPTY 的幽灵记录，
  // 财务翻审计日志时会以为真发生过计提。故 dry-run 传 false 把它闭掉。
  // 线上调用方不传 = undefined ≠ false → 行为与改动前完全一致（--apply 同样照常落审计）。
  options?: { emitEmptyAccrualAudit?: boolean },
) {
  // 0. 幂等：粒度是 **(订单, productKind)**，不是「这单有没有任意一条记录」。
  // _updateStatusWithinTx 只在 toStatus==='PAID' 时调用本函数，正常状态机每单只会经过一次
  // PENDING_PAYMENT→PAID，所以只会跑一次。唯一能让同一订单二次触达 PAID 的路径是 admin force
  // （如误操作 force CANCELLED→PAID"复活"一张已释放单）——没有这层幂等保护就会对同一笔订单重复
  // 计佣（下面按链路逐级 create 一遍 CommissionRecord，两次共 2N 条，代理端看见的应得佣金翻倍）。
  // 这个必须防的场景，per-productKind 粒度一样防得住：已建过记录的那一档会被跳过。
  //
  // 为什么从「整单」收细到「按档」：套餐单付款时机票腿命中 FLIGHT 费率建了记录、BUNDLE 档没配
  // 费率建不出记录，整单粒度的闸会把这张单**永久锁死**——将来费率配齐了也不敢跑补提脚本，
  // 一跑就把机票那部分重复计提。按档判定后补提可安全重跑：只补缺的档，已有的档原样跳过。
  //
  // 仍然不区分 status（ACCRUED/REVERSED/SETTLED 都算"这一档已生成过"）：
  //   · 冲销（退款/取消）走的是「原记录翻 REVERSED / 另建负数补偿记录」，钱账已经平了；
  //     若这里把 REVERSED 当作"没跑过"，force 复活一张退过款的单就会在负数记录之上再计一遍
  //     正数，代理凭空多拿一份——这正是原闸要防的事故，语义必须原样保留。
  //   · 补提脚本要补的是「从来没建过记录」的档，那种档在这张表里一条都没有（任何 status 都没有），
  //     所以不区分 status 不会挡住补提。
  const accruedKindRows = await tx.commissionRecord.findMany({
    where: { orderId },
    select: { productKind: true },
    distinct: ['productKind'],
  });
  const accruedKinds = new Set<ProductKind>(accruedKindRows.map((r) => r.productKind));

  // 1. 拉订单项
  // 必须联查班次的 departureTime/departureTz：下面要用 deriveOrderDepartDate 派生「整单出发日」
  // 作为费率比对基准，而该函数是「依赖已联查的行数据、不另发查询」的——扁平 findMany 拿不到
  // flightSchedule，航班部分会静默落空退化成只看 hotelCheckIn（纯机票单直接派生出 null），
  // 费率就比错了且没有任何报错。select 只取这两列，对事务的额外开销可忽略。
  const items = await tx.orderItem.findMany({
    where: { orderId },
    include: { flightSchedule: { select: { departureTime: true, departureTz: true } } },
  });
  if (items.length === 0) return;

  // 1.2 幂等闸的另一半：本单还有哪些档没计提过。
  // 全部档都已计提过（且确实有计提过的档）→ 什么都不用做，提前 return，连代理链路都不必解析。
  // 「一个可计提档都没有」（如纯保险单）不在此列 —— 那种单要一路走到底，落零计提审计（见 4）。
  const pendingKinds = new Set<ProductKind>();
  for (const item of items) {
    const pk = ORDER_ITEM_KIND_TO_PRODUCT_KIND[item.kind];
    if (pk && !accruedKinds.has(pk)) pendingKinds.add(pk);
  }
  if (pendingKinds.size === 0 && accruedKinds.size > 0) return;

  // 1.5 费率比对基准 = 本单「出发日」，不是计提当刻（new Date()）。
  // 口径（财务）：佣金按出发日算——例如「2026-09-01 及以后起飞的订单才开始计佣金」，靠给规则配
  //   effectiveFrom=2026-09-01 落地；8/30 起飞的单即使今天下单、今天付款也不该吃到这档费率。
  //   反过来，今天付款、9 月才飞的单要按 9 月那档算——这正是改成比出发日的意义。
  // 整单出发日复用 deriveOrderDepartDate（订单列表「出发日期」列同一函数），不另写一套取最早的
  //   逻辑：取最早航段的当地出发日，无航段回退最早入住日。往返单按去程（最早）判，
  //   例如去程 8/30、回程 9/2 → 算 8/30 → 不计——保证「列表所见 = 计佣所依」。
  // 改签不追溯是有意为之：佣金只在本函数唯一触达点计提一次并写死，事后改签把出发日改了也不重算。
  //   佣金一旦入账即为代理的既得应收，不能被后续行程变更翻旧账；函数开头的幂等闸保证只算一次。
  const departDate = deriveOrderDepartDate(items);
  // 比的是「出发日这一整天」而不是当天零点：effectiveFrom 存的是规则保存那一刻的完整时间戳
  //   （运营下午改费率就是当天 15:xx，不是零点），拿零点去比会让规则在自己生效当天匹配不上，
  //   白差一天。语义 = 规则的生效区间与出发日这一天有交集（两端含边界）。
  // 出发日为 null（既无航段也无酒店的单，如纯保险/纯手工费单）→ 回退到计提当刻，保持改动前的
  //   行为；绝不因为派生不出出发日就静默跳过计提，那会让代理凭空少一笔应收。
  //
  // 日窗口一律按**公司业务日（上海）**锚定，不用 UTC：财务说的「9 月 1 日起飞开始算返佣」
  //   指的是北京时间的 9 月 1 日。按 UTC 锚会把北京时间 9/1 凌晨 0–8 点起飞的航班算成 8/31，
  //   在 9/1 这条硬分界线上凭空吃掉一批单的佣金。
  // 关键不变式：**此处锚点必须与 PUT /agents/:id/commission-rules 写 effectiveFrom 的锚点一致**
  //   （那边同样是 localToUtc(日期,'00:00',BUSINESS_TZ)）。两边一致时该比较等价于纯日期字符串
  //   比较，无时区歧义；任一边改回 UTC 零点都会系统性差一天。
  const rateBasisStart = departDate ? localToUtc(departDate, '00:00', BUSINESS_TZ) : new Date();
  // 出发日当天 23:59:59.999（上海）= 次日零点减 1 毫秒，不留 23:59:00~23:59:59 的缝。
  const rateBasisEnd = departDate
    ? new Date(rateBasisStart.getTime() + 24 * 60 * 60 * 1000 - 1)
    : rateBasisStart;

  // 2. 算链路（seller → parent → grandparent ...）
  const chain: Array<{ agentId: string; depth: number }> = [];
  let cur: string | null = sellerAgentId;
  let depth = 0;
  while (cur) {
    chain.push({ agentId: cur, depth });
    const parentRow: { parentAgentId: string | null } | null = await tx.agent.findUnique({
      where: { id: cur },
      select: { parentAgentId: true },
    });
    cur = parentRow?.parentAgentId ?? null;
    depth++;
    if (depth > 10) break; // 防御：层级超 10 级直接断
  }

  // 2.5 折扣分摊：计佣基数是「实际收到的钱」，不是订单行毛额。
  //
  // 口径（财务已拍板）：返佣按实收算，折扣要从计佣基数里扣掉。DISCOUNT 行（同业立减、录单
  // 让利、代理结算价负差…金额本身为负）不在 ORDER_ITEM_KIND_TO_PRODUCT_KIND 里，逐行毛额
  // 计提时被 `if (!productKind) continue` 跳过 —— 折扣完全没扣，代理单会系统性多付。
  //
  // 算法（折扣按可计提行的毛额比例分摊）：
  //   可计提毛额 G = Σ(映射表里有 productKind 的行 amount)
  //   折扣总额   D = Σ(DISCOUNT 行 amount)     // 本身为负
  //   可计提净额 N = max(0, G + D)
  //   每行计佣基数 = 行 amount × (N / G)
  // 例：BUNDLE 450 + FLIGHT 800 + FLIGHT 1000 + DISCOUNT −1032
  //     → G=2250、D=−1032、N=1218、ratio=0.541333…
  //     → 243.60 / 433.07 / 541.33，合计 1218.00 = 订单实收。
  //
  // 只摊到「可计提行」上，不摊给 FEE/INSURANCE/GUIDE/UPGRADE_CHANGE/OVERSALE：
  //   · FEE 是机建燃油等代收代付（转手交航司，本就不打折），把它算进分母会稀释比例、
  //     让计佣基数虚高，等于折扣没扣干净；
  //   · 其余几类另有口径且本来就不计佣，进分母同样只会把基数抬高。
  //   把它们排除在分母外 = 折扣全额由可计提行承担，这是对代理最保守（绝不多付）的口径。
  //
  // ⚠️ 下面这处不对称是**财务明确拍板保留的，不是遗漏，复审时不要"顺手修好"**：
  //   结算价与系统标价的差额按正负走两个不同的行类型（见 buildSettlementTotalItem）——
  //     谈定价 **低于** 标价 → 落 DISCOUNT（负）→ **扣减**计佣基数；
  //     谈定价 **高于** 标价 → 落 FEE（正）  → **不加**计佣基数。
  //   即「少收的要减佣、多收的不加佣」，两头都对我方有利、永远少付不多付。
  //   严格按「按实收算」本该把后者也加进基数，财务权衡后选择维持现状（连同机建燃油一并不计）。
  //   真要改，得先按 metadata.reasonCode 给 FEE 行分语义（SETTLEMENT / MISC_FEE / ROOM_DIFF …），
  //   因为 FEE 这个枚举被多种含义复用，整体放开会把代收代付也算进去。
  //
  // G ≤ 0（整单只有折扣行 / 没有任何可计提行）→ ratio=0 → 所有基数为 0 → 不建任何记录，
  //   并落零计提审计（见 4）。绝不用负基数或 1 兜底 —— 那会算出负佣金或按毛额多付。
  let grossCommissionable = 0;
  let discountTotal = 0;
  for (const item of items) {
    if (ORDER_ITEM_KIND_TO_PRODUCT_KIND[item.kind]) {
      grossCommissionable += Number(item.amount);
    } else if (item.kind === OrderItemKind.DISCOUNT) {
      discountTotal += Number(item.amount);
    }
  }
  grossCommissionable = round2(grossCommissionable);
  discountTotal = round2(discountTotal);
  // N 先 round2 再相除：G/D 都是 2 位小数金额，先规整能消掉浮点累加的尾巴（如 …0000001）。
  const netCommissionable = Math.max(0, round2(grossCommissionable + discountTotal));
  const discountRatio = grossCommissionable > 0 ? netCommissionable / grossCommissionable : 0;

  // 3. 为每个 item 按 productKind 生成 records
  let createdCount = 0;
  for (const item of items) {
    const productKind = ORDER_ITEM_KIND_TO_PRODUCT_KIND[item.kind];
    // 映射表里没有的订单行 kind 不参与计提，当前为：
    //   INSURANCE / FEE（机建燃油）/ DISCOUNT / GUIDE / UPGRADE_CHANGE / OVERSALE。
    // 改 OrderItemKind 时记得回来核一遍这份名单，别让新 kind 静默漏计（BUNDLE 就是这么漏的）。
    // DISCOUNT 在这里照旧跳过 —— 它不是"一档产品"，而是通过上面的 ratio 摊进各可计提行的基数。
    if (!productKind) continue;
    // 幂等（按档）：这一档已经有记录了 → 跳过，连费率都不必查。
    if (accruedKinds.has(productKind)) continue;

    // 计佣基数 = 行毛额 × 折扣分摊比例（无折扣时 ratio=1，等于毛额，存量语义不变）。
    // 逐行 round2：每行误差 ≤ 0.005 元，Σ基数 与 N 的偏差上界 = 0.005 × 可计提行数
    //   （常见 2–5 行 → ≤ 2.5 分），且佣金金额还要再乘费率，落到钱上远小于 1 分，无可见漂移。
    const baseAmount = round2(Number(item.amount) * discountRatio);
    // 基数为 0（折扣吃光全单，或行本身就是 0 元赠品）→ 不建记录：0 元佣金记录只会污染结算单。
    if (baseAmount <= 0) continue;

    // 取链路上每个代理对该 productKind 的 rate（在本单出发日当天生效的那档，见 1.5 的口径说明）
    // 按 effectiveFrom DESC 排序，每个 agent 取第一条 = 出发日当天最新生效的规则
    // （之前是"取最大 rate"，降档后还按高佣跑，是 bug）
    const rules = await tx.commissionRule.findMany({
      where: {
        agentId: { in: chain.map((c) => c.agentId) },
        productKind,
        effectiveFrom: { lte: rateBasisEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: rateBasisStart } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
    const rateByAgent = new Map<string, number>();
    for (const r of rules) {
      if (!rateByAgent.has(r.agentId)) {
        rateByAgent.set(r.agentId, Number(r.rate));
      }
    }

    // 沿着链路从底向上，每个代理拿 (自己 rate - 下级 rate) × baseAmount（基数已是净额）
    let lowerRate = 0; // 下级代理的 rate（seller 的 "下级" 是 0，表示没有）
    for (let i = 0; i < chain.length; i++) {
      const { agentId, depth: d } = chain[i];
      const thisRate = rateByAgent.get(agentId) ?? 0;
      // 不变式：child rate ≤ parent rate — 若违反，spread 为负，跳过
      const netRate = thisRate - lowerRate;
      if (netRate > 0.00005) {
        const amt = Math.round(baseAmount * netRate * 100) / 100;
        await tx.commissionRecord.create({
          data: {
            agentId,
            orderId,
            productKind,
            baseAmount: new Prisma.Decimal(baseAmount),
            rate: new Prisma.Decimal(netRate),
            amount: new Prisma.Decimal(amt),
            chainDepth: d,
            status: CommissionStatus.ACCRUED,
          },
        });
        createdCount++;
      }
      // 下一轮循环：上一级代理看本级作为"下级"
      if (thisRate > lowerRate) lowerRate = thisRate;
    }
  }

  // 4. 零计提可见性：代理单走完整条链路，一条 CommissionRecord 都没建。
  // 旧实现在这里静默返回——零日志、零审计、零告警，财务事后无从发现「这单为什么没佣金」。
  // 最常见的原因是费率没配（新代理 / 新产品档），其次是折扣把可计提净额吃光。落一条 WARNING
  // 审计，把查证需要的信息一次带全：订单号、卖家代理与整条链路、出发日（费率比对基准）、
  // 涉及的 productKind、以及毛额/折扣/净额三个数。
  //
  // 事务边界：writeAudit 走的是全局 prisma（不是本函数的 tx），所以审计写入既不进业务事务、
  // 也不会因为业务事务回滚而丢/留；severity=WARNING 时它内部 catch 住所有异常只打 console
  // （只有 CRITICAL 才上抛），故审计失败绝不会影响计提本身。用 void 不 await，不让审计的
  // 网络往返把事务多按住一个 RTT。
  if (createdCount === 0 && options?.emitEmptyAccrualAudit !== false) {
    void writeAudit({
      actor: { role: 'SYSTEM' },
      action: 'COMMISSION_ACCRUAL_EMPTY',
      targetType: AuditTargetType.COMMISSION,
      targetId: orderId,
      targetLabel: orderNumber ?? orderId,
      severity: AuditSeverity.WARNING,
      after: {
        orderId,
        orderNumber: orderNumber ?? null,
        sellerAgentId,
        agentChain: chain.map((c) => c.agentId),
        departDate,
        productKinds: [...pendingKinds],
        grossCommissionableCny: grossCommissionable,
        discountCny: discountTotal,
        netCommissionableCny: netCommissionable,
      },
    });
  }
}
