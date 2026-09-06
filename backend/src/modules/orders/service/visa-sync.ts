// 由 orders.service.ts 机械拆出（审查根因 R5，2026-09-06）：只搬代码、不改口径。
// 对外契约仍从 ../orders.service.js 取（facade 原名再导出）；OrderService 方法体在这里是
// `export function xxx(svc: OrderService, ...)`，方法里的 `this.` 一律写成 `svc.`——
// 跨组调用仍走 facade 实例，单测里对 OrderService 实例的 spy 行为不变。

import {
  AuditSeverity,
  AuditTargetType,
  OrderItemKind,
  OrderStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import { writeAudit } from '../../../lib/audit.js';
import { orderNeedsVisaTask, orderVisaStatusRequiresVisa } from '../visa-need.js';
import {
  VISA_AUTO_COMPLETE_ACTION,
  VISA_AUTO_COMPLETE_REVERT_ACTION,
} from '../../fulfillment/visa-completion.js';
import { FulfillmentStatus, FulfillmentType, VisaRequirement } from '@prisma/client';
import { FULFILLMENT_TERMINATING_STATUSES } from './shared.js';

/**
 * 拆单 · 签证任务承接（9c）。
 *
 * 源单的签证任务不是「被拆的行」上的普通任务：订单级需签时它按锚点规则挂在**首个订单项**
 * （见 resolveVisaTaskAnchor），拆出去的人的送签进度（Passenger.visaSubmissionStatus）随人搬家，
 * 订单级「已签证」也被原样复制到新单。可新单 visaStatus=HAS_VISA 在建任务口径里等于
 * 「客人自带签证」（orderNeedsVisaTask 一票否决）→ createFulfillmentTasks / syncVisaTasksForOrder
 * 都不给新单建签证任务，9b 的镜像也就无从下手。结果：拆出的人在订单列表挂着「已签证」、
 * 乘客也「已送签」，签证台却搜不到这个人（签证台读的是 VISA_APPLICATION 任务；公测反馈）。
 *
 * 口径：源单有活的（非 CANCELLED）签证任务 + 新单有非自备签乘客 + 新单还没有活的签证任务
 * → 在新单补一条**镜像源任务**的签证任务（状态 / 材料 data / 备注 / 起止时间 / 签证成本三字段 /
 * 签证公司），锚点优先取源任务所在行对应的新行（splitItemIdMap），其次按建单同一套锚点规则，
 * 最后兜底新单首行。源单任务不动（留守的人继续挂在源单）。
 *
 * 办结审计对称：源单的「已签证」若是自动办结写的（最近一条 AUTO_COMPLETE_VISA），新单同样记一条
 * AUTO_COMPLETE_VISA（before 沿用源单的办结前原档）——这样在新单上把乘客退回待送时，
 * visa-completion 的对称回退才认得这是派生值、会自动撤销办结；否则新单的 HAS_VISA 会被当成
 * 录单手选的「客人自带签证」永远退不回去。审计 fire-and-forget、不进事务（与全文件同款）。
 *
 * 幂等：新单已有活的签证任务（无论谁建的）就不动；重复调用零写入。
 */
export async function carryVisaTaskForSplit(
  tx: Prisma.TransactionClient,
  input: {
    sourceOrderId: string;
    targetOrderId: string;
    sourceOrderNumber: string;
    targetOrderNumber: string;
    /** 源行 id → 新单对应行 id（拆分行） */
    splitItemIdMap: Map<string, string>;
    splitNote: string;
    actor: { userId: string; role: UserRole };
  },
): Promise<{ taskId: string } | null> {
  const visaTaskSelect = {
    orderItemId: true,
    status: true,
    data: true,
    notes: true,
    startedAt: true,
    completedAt: true,
    visaUnitCostUsd: true,
    visaFxRate: true,
    visaUnitCostCny: true,
    visaSupplier: true,
  } as const;
  const sourceTasks = await tx.fulfillmentTask.findMany({
    where: {
      orderItem: { orderId: input.sourceOrderId },
      type: FulfillmentType.VISA_APPLICATION,
      status: { not: FulfillmentStatus.CANCELLED },
    },
    select: visaTaskSelect,
    orderBy: { createdAt: 'asc' },
  });
  const source = sourceTasks[0];
  if (!source) return null;

  const targetTasks = await tx.fulfillmentTask.findMany({
    where: {
      orderItem: { orderId: input.targetOrderId },
      type: FulfillmentType.VISA_APPLICATION,
      status: { not: FulfillmentStatus.CANCELLED },
    },
    select: { id: true },
  });
  if (targetTasks.length > 0) return null;

  // 拆出去的人里得有要我方代办的：全员自备签的一拨人过去，签证台本就无事可做
  const targetPax = await tx.passenger.findMany({
    where: { orderId: input.targetOrderId, visaExempt: false },
    select: { id: true },
  });
  if (targetPax.length === 0) return null;

  const targetItems = await tx.orderItem.findMany({
    where: { orderId: input.targetOrderId },
    select: { id: true, kind: true, bundleId: true },
    orderBy: { createdAt: 'asc' },
  });
  if (targetItems.length === 0) return null;
  const targetOrder = await tx.order.findUnique({
    where: { id: input.targetOrderId },
    select: { visaStatus: true },
  });
  const mappedAnchor = input.splitItemIdMap.get(source.orderItemId);
  const anchorItemId =
    (mappedAnchor && targetItems.some((item) => item.id === mappedAnchor) ? mappedAnchor : null) ??
    (await resolveVisaTaskAnchor(tx, targetItems, targetOrder?.visaStatus)).anchorItemId ??
    targetItems[0].id;

  const task = await tx.fulfillmentTask.create({
    data: {
      orderItemId: anchorItemId,
      type: FulfillmentType.VISA_APPLICATION,
      status: source.status,
      data: source.data === null ? Prisma.DbNull : (source.data as Prisma.InputJsonValue),
      notes: [source.notes?.trim() || null, input.splitNote].filter(Boolean).join(' · '),
      startedAt: source.startedAt,
      completedAt: source.completedAt,
      visaUnitCostUsd: source.visaUnitCostUsd,
      visaFxRate: source.visaFxRate,
      visaUnitCostCny: source.visaUnitCostCny,
      visaSupplier: source.visaSupplier,
    },
    select: { id: true },
  });

  // 办结审计对称（见函数头）：源单最近一条办结审计是 AUTO_COMPLETE_VISA 且新单复制到了 HAS_VISA
  if (targetOrder?.visaStatus === VisaRequirement.HAS_VISA) {
    const lastAuto = await tx.auditLog.findFirst({
      where: {
        targetType: AuditTargetType.ORDER,
        targetId: input.sourceOrderId,
        action: { in: [VISA_AUTO_COMPLETE_ACTION, VISA_AUTO_COMPLETE_REVERT_ACTION] },
      },
      orderBy: { createdAt: 'desc' },
      select: { action: true, before: true },
    });
    if (lastAuto?.action === VISA_AUTO_COMPLETE_ACTION) {
      void writeAudit({
        actor: input.actor,
        action: VISA_AUTO_COMPLETE_ACTION,
        targetType: AuditTargetType.ORDER,
        targetId: input.targetOrderId,
        targetLabel: input.targetOrderNumber,
        before: (lastAuto.before ?? { visaStatus: VisaRequirement.NEEDED }) as Prisma.InputJsonValue,
        after: {
          visaStatus: VisaRequirement.HAS_VISA,
          reason: `随拆单承接源单 ${input.sourceOrderNumber} 的自动办结`,
          carriedTaskId: task.id,
        },
      });
    }
  }
  return { taskId: task.id };
}

// ── Fulfillment 任务生成（PAID 时触发） ─────────────────────────

// 非套餐订单项：一行 → 一个对应岗任务。
export const KIND_TO_FULFILLMENT_TYPE: Partial<Record<OrderItemKind, FulfillmentType>> = {
  FLIGHT: FulfillmentType.FLIGHT_TICKETING,
  HOTEL: FulfillmentType.HOTEL_BOOKING,
  VISA: FulfillmentType.VISA_APPLICATION,
  TRANSFER: FulfillmentType.TRANSFER_DISPATCH,
};

// 套餐组件 kind（Bundle.items[].kind，见 products.schemas bundleItemSchema）→ 对应岗任务。
// 注意：FLIGHT 组件不在此列 —— 套餐下单已单独落 FLIGHT 订单项（FLIGHT_TICKETING 由那行生成），
//       从套餐再生成会与之重复，故套餐只 fan-out 地面（酒店/签证/接送）组件。
export const BUNDLE_COMPONENT_KIND_TO_TYPE: Record<string, FulfillmentType | undefined> = {
  HOTEL: FulfillmentType.HOTEL_BOOKING,
  VISA: FulfillmentType.VISA_APPLICATION,
  TRANSFER: FulfillmentType.TRANSFER_DISPATCH,
};

/**
 * 解析套餐订单项需要生成哪些「地面岗」任务类型。
 * 通过订单项的 bundleId 反查 Bundle.items JSON，取其组件 kind 集合映射到 FulfillmentType。
 * 解析不到（bundleId 缺失 / 套餐被删 / items 畸形）时优雅降级：
 *   至少回退一个 HOTEL_BOOKING（套餐基本必含酒店），保证酒店岗能看到该套餐单。
 */
export async function resolveBundleFulfillmentTypes(
  tx: Prisma.TransactionClient,
  bundleId: string | null,
): Promise<FulfillmentType[]> {
  const FALLBACK = [FulfillmentType.HOTEL_BOOKING];
  if (!bundleId) return FALLBACK;
  const bundle = await tx.bundle.findUnique({
    where: { id: bundleId },
    select: { items: true },
  });
  if (!bundle) return FALLBACK;
  const components = Array.isArray(bundle.items)
    ? (bundle.items as Array<{ kind?: unknown }>)
    : [];
  // 去重保序：同一类组件（如两段接送）只开一个对应岗任务。
  const types = new Set<FulfillmentType>();
  for (const c of components) {
    if (typeof c?.kind !== 'string') continue;
    const type = BUNDLE_COMPONENT_KIND_TO_TYPE[c.kind];
    if (type) types.add(type);
  }
  return types.size > 0 ? [...types] : FALLBACK;
}

/**
 * PAID 时为订单的每个订单项生成 fulfillment 任务。
 *
 * - 非套餐项（FLIGHT/HOTEL/VISA/TRANSFER）：一行 → 一个对应岗任务。
 * - 套餐项（BUNDLE）：反查套餐组件，fan-out 成 per-component 地面岗任务
 *   （HOTEL→HOTEL_BOOKING / VISA→VISA_APPLICATION / TRANSFER→TRANSFER_DISPATCH），
 *   不再生成单一 BUNDLE_COMPOSITE 占位任务 —— 否则签证岗/酒店岗/地面岗看不到套餐单。
 *   （FLIGHT 组件由套餐另落的 FLIGHT 订单项生成，避免重复。）
 *
 * 幂等：按「该订单项已存在的任务类型集合」判定，只补缺失的类型。
 *   首次运行会一次性建齐所有需要的类型；重跑不会重复建（即便套餐含多类型，
 *   旧的 `fulfillmentTasks.length > 0` 单值守卫会漏建剩余类型，故改为按类型去重）。
 */
export async function createFulfillmentTasks(tx: Prisma.TransactionClient, orderId: string): Promise<string[]> {
  // 订单级签证状态：visaStatus=NEEDED / E_VISA（电子签·三个月多次，同样需要送签办理）
  // 的订单即便没有 VISA 行/套餐签证组件，也要进签证台（让签证岗看见并按类型筛选）。
  // NOT_NEEDED/HAS_VISA 不开任务。
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { visaStatus: true },
  });
  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: {
      id: true,
      kind: true,
      bundleId: true,
      fulfillmentTasks: { select: { type: true, status: true } },
    },
  });
  const newTaskIds: string[] = [];
  // 去重口径按「(type, 非终态)」：CANCELLED 任务视为不存在，其余（PENDING/IN_PROGRESS/CONFIRMED/FAILED）
  // 都算已存在、不重复建。据此 force 取消族 → PAID 复活时：被 P2-16 终态化成 CANCELLED 的任务不再挡路，
  // 缺失的活动任务会重建成 PENDING（订单看板有可执行任务）；CONFIRMED/FAILED 等仍活着的不会被重复建。
  //   与 A1（resetVisa 绝不碰 CANCELLED）一致：CANCELLED 永远冻结为终态，只当历史记录、不复活。
  const isActiveTask = (s: FulfillmentStatus): boolean => s !== FulfillmentStatus.CANCELLED;
  // 全单是否已（含本次新建）存在「活动」签证任务 —— 用于订单级「需要签证」去重，避免重复建。
  let hasVisaTask = items.some((item) =>
    item.fulfillmentTasks.some(
      (t) => t.type === FulfillmentType.VISA_APPLICATION && isActiveTask(t.status),
    ),
  );
  // 乘客级一票否决：全员自备签 → 本单不建签证任务（判定见 visa-need.ts）。
  // 签证台按 visaExempt=false 过滤乘客，全员自备签时任务点进去是零乘客的空壳。
  // 懒查 + 记忆：只有真要建签证任务时才回表，不给「与签证无关的单」平白加一次查询。
  let paxForVisa: Array<{ visaExempt: boolean }> | null = null;
  const loadPaxForVisa = async (): Promise<Array<{ visaExempt: boolean }>> => {
    if (paxForVisa === null) {
      paxForVisa = await tx.passenger.findMany({
        where: { orderId },
        select: { visaExempt: true },
      });
    }
    return paxForVisa;
  };
  for (const item of items) {
    // 该订单项需要的任务类型集合
    const desiredTypes =
      item.kind === OrderItemKind.BUNDLE
        ? await resolveBundleFulfillmentTypes(tx, item.bundleId)
        : (() => {
            const t = KIND_TO_FULFILLMENT_TYPE[item.kind];
            return t ? [t] : [];
          })();
    if (desiredTypes.length === 0) continue;

    // 幂等：跳过已有「活动」任务的类型，只补缺失的（含被取消后复活时重建 PENDING；支持套餐多类型部分补建）
    const existingTypes = new Set(
      item.fulfillmentTasks.filter((t) => isActiveTask(t.status)).map((t) => t.type),
    );
    for (const type of desiredTypes) {
      if (existingTypes.has(type)) continue;
      // 商品级涉签（VISA 行 / 含签证组件套餐）也要过订单级与乘客级这两关：
      // 判定整条交给 orderNeedsVisaTask（visa-need.ts 的单一口径），别在这里手抄半条——
      // 录单选了「不需要签证」的单，商品级涉签压不过订单级的一票否决。
      if (
        type === FulfillmentType.VISA_APPLICATION &&
        !orderNeedsVisaTask({
          visaStatus: order?.visaStatus,
          hasVisaScope: true, // 走到这里说明本行商品级确已涉签
          passengers: await loadPaxForVisa(),
        })
      ) {
        continue;
      }
      const task = await tx.fulfillmentTask.create({
        data: {
          orderItemId: item.id,
          type,
          status: FulfillmentStatus.PENDING,
        },
      });
      newTaskIds.push(task.id);
      if (type === FulfillmentType.VISA_APPLICATION) hasVisaTask = true;
    }
  }

  // 订单级「需要签证」：本单需签且全程没有任何签证任务（VISA 行 / 套餐签证组件都没产生）
  // → 补一条 VISA_APPLICATION，挂到首个订单项（FulfillmentTask 仅有 orderItemId 外键，
  // 无 Order 直挂）。已有签证任务则跳过，保证重跑 PAID 不重复建（幂等）。
  // `orderVisaStatusRequiresVisa` 只作「能否省掉回表」的廉价前置筛：订单级都不需签就不必查乘客。
  // 真正的判定权威始终是 orderNeedsVisaTask（三根轴收口在那里）。
  if (
    !hasVisaTask &&
    items.length > 0 &&
    orderVisaStatusRequiresVisa(order?.visaStatus) &&
    orderNeedsVisaTask({
      visaStatus: order?.visaStatus,
      passengers: await loadPaxForVisa(),
    })
  ) {
    const task = await tx.fulfillmentTask.create({
      data: {
        orderItemId: items[0].id,
        type: FulfillmentType.VISA_APPLICATION,
        status: FulfillmentStatus.PENDING,
      },
    });
    newTaskIds.push(task.id);
  }
  return newTaskIds;
}

/**
 * 签证任务锚点解析 —— 回答两件事：「本单商品级涉不涉签」+「签证任务该挂在哪一行」。
 *
 * FulfillmentTask 只有 orderItemId 外键、没有 Order 直挂，所以订单级需签的单也得找一行挂着。
 * 优先级（建单路径与事件驱动同步共用，保证同一单永远挑同一行，不会挂出两条锚点不同的任务）：
 *   1. VISA 订单项；
 *   2. 含签证组件的 BUNDLE 订单项；
 *   3. 订单级 visaStatus 需签时的首个订单项（兜底）。
 *
 * `hasVisaScope` 只表示**商品级**涉签（前两级命中）——订单级那根轴由调用方把 visaStatus
 * 一并交给 orderNeedsVisaTask 判定，两根轴不在此处提前合流，免得口径糊在一起。
 */
export async function resolveVisaTaskAnchor(
  tx: Prisma.TransactionClient,
  items: ReadonlyArray<{ id: string; kind: OrderItemKind; bundleId: string | null }>,
  visaStatus: VisaRequirement | null | undefined,
): Promise<{ anchorItemId: string | null; hasVisaScope: boolean }> {
  if (items.length === 0) return { anchorItemId: null, hasVisaScope: false };
  const visaItem = items.find((item) => item.kind === OrderItemKind.VISA);
  if (visaItem) return { anchorItemId: visaItem.id, hasVisaScope: true };
  for (const item of items) {
    if (item.kind !== OrderItemKind.BUNDLE) continue;
    const types = await resolveBundleFulfillmentTypes(tx, item.bundleId);
    if (types.includes(FulfillmentType.VISA_APPLICATION)) {
      return { anchorItemId: item.id, hasVisaScope: true };
    }
  }
  if (orderVisaStatusRequiresVisa(visaStatus)) {
    return { anchorItemId: items[0].id, hasVisaScope: false };
  }
  return { anchorItemId: null, hasVisaScope: false };
}

/**
 * 下单（CREATE）时即建签证任务 —— 让「录进去但还没付款」的需签证单也能进签证台。
 *
 * 背景：完整履约任务（机票/酒店/接送/签证）在 PAID 时才由 createFulfillmentTasks 生成，
 * 于是未付款订单一个任务都没有，签证台（读 VISA_APPLICATION 任务）看不到要送签的单。
 * 这里只在下单时**提前补签证那一项**，其余岗位任务仍留到 PAID。
 *
 * 「需要签证」判定（任一成立，与 PAID 路径一致）：
 *   - 订单级 visaStatus = NEEDED / E_VISA
 *   - 含 VISA 订单项
 *   - 含 BUNDLE 订单项，且该套餐组件含 VISA
 * 但订单级 visaStatus = NOT_NEEDED / HAS_VISA 一票否决以上三条（口径见 visa-need.ts 的
 * orderNeedsVisaTask）：录单明说「不需要签证」或「已签证」的单，含签证组件的套餐也不建任务，
 * 不再依赖录单弹窗的前端联动。
 *
 * 任务锚点与 PAID 路径保持一致（VISA 项 → 该项；含签证套餐 → 该套餐项；
 * 否则订单级需签 → 首个订单项），并按「已存在 VISA 任务即跳过」幂等：
 * PAID 时 createFulfillmentTasks 按订单项的已有任务类型去重，能识别这条早建任务而不重复建。
 */
export async function createVisaTaskAtCreation(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<string[]> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { visaStatus: true },
  });
  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: {
      id: true,
      kind: true,
      bundleId: true,
      fulfillmentTasks: { select: { type: true } },
    },
  });
  if (items.length === 0) return [];

  // 幂等：已存在任意签证任务 → 不重复建
  const alreadyHasVisaTask = items.some((item) =>
    item.fulfillmentTasks.some((t) => t.type === FulfillmentType.VISA_APPLICATION),
  );
  if (alreadyHasVisaTask) return [];

  // 锚点选择（与 PAID 路径一致）：优先 VISA 项 → 含签证套餐项 → 订单级需签时首个订单项
  const { anchorItemId } = await resolveVisaTaskAnchor(tx, items, order?.visaStatus);
  if (!anchorItemId) return [];

  // 乘客级一票否决：全员自备签 → 不建（与 PAID 路径同一判定）。
  // 放在锚点选定之后：与签证无关的单在上面就 return 了，不必平白查一次乘客。
  const paxForVisa = await tx.passenger.findMany({
    where: { orderId },
    select: { visaExempt: true },
  });
  if (
    !orderNeedsVisaTask({
      visaStatus: order?.visaStatus,
      hasVisaScope: true, // 走到这里说明锚点已选中 → 本单商品级/订单级确已涉签
      passengers: paxForVisa,
    })
  ) {
    return [];
  }

  const task = await tx.fulfillmentTask.create({
    data: {
      orderItemId: anchorItemId,
      type: FulfillmentType.VISA_APPLICATION,
      status: FulfillmentStatus.PENDING,
    },
  });
  return [task.id];
}

/** 某订单「签证任务该是什么样」的只读快照（判定 + 现状），见 evaluateOrderVisaTaskState。 */
export interface OrderVisaTaskState {
  orderNumber: string;
  visaStatus: VisaRequirement | null;
  /** 订单状态（判定时要看：取消族终态一律判「不需要任务」）。 */
  status: OrderStatus;
  /** 软删时间戳（非 null = 已进回收站，同样判「不需要任务」）。 */
  deletedAt: Date | null;
  /**
   * 本单是否已「不参与履约」——取消族终态（FULFILLMENT_TERMINATING_STATUSES）或已软删。
   * 为真时 needed 恒 false，与订单状态流转时把履约任务终态化的口径同源，不另立一套。
   */
  inactive: boolean;
  /** 权威判定（visa-need.ts 的 orderNeedsVisaTask）：本单还要不要我方代办签证。 */
  needed: boolean;
  /** 需要建任务时该挂的订单项；null = 无处可挂（如空订单项的单）。 */
  anchorItemId: string | null;
  passengerCount: number;
  /** 本单现存的全部签证任务（含各自状态，CANCELLED 也在内）。 */
  visaTasks: Array<{ id: string; status: FulfillmentStatus }>;
}

/**
 * 只读重算「本单的签证任务该是什么样」—— 判定与现状一并返回，一行库都不写。
 *
 * syncVisaTasksForOrder（写侧）与存量清理脚本的 dry-run 共用本函数：
 * 预览看到的判定，就是 --apply 会依据的那个判定，两边不会各算一套。
 * 订单不存在 → null。
 *
 * 「不参与履约」的两类单一律判 needed=false，不看签证口径（P1-6）：
 *   · 取消族终态（FULFILLMENT_TERMINATING_STATUSES：CANCELLED/REFUNDED/PAYMENT_TIMEOUT/FAILED）——
 *     订单流转到这些状态时履约任务已被一并终态化，若这里还按签证口径判「需要」，
 *     一次改备注（改订单级签证状态）就会给已取消的单凭空补出一条 PENDING，签证台上冒出
 *     根本不用办的活。DRAFT 不在此列：它只是座位账口径上的释放型，不是「订单被取消」。
 *   · 已软删（deletedAt≠null，回收站单）—— 全站列表/导出都已让它消失，签证台更不该看见。
 * 反向也成立：这两类单里残留的 PENDING 任务，会被写侧按 needed=false 顺手撤掉（正确的清理）。
 */
export async function evaluateOrderVisaTaskState(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<OrderVisaTaskState | null> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { visaStatus: true, orderNumber: true, status: true, deletedAt: true },
  });
  if (!order) return null;
  // deletedAt 用 Boolean 判空（null/undefined 一并当「未删」）：Date 对象恒为真值，
  // 调用方少 select 一个字段时按「未删」保守放行，不会把正常单误判成回收站单。
  const inactive =
    Boolean(order.deletedAt) || FULFILLMENT_TERMINATING_STATUSES.includes(order.status);

  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: {
      id: true,
      kind: true,
      bundleId: true,
      fulfillmentTasks: { select: { id: true, type: true, status: true } },
    },
  });
  const passengers = await tx.passenger.findMany({
    where: { orderId },
    select: { visaExempt: true },
  });
  const { anchorItemId, hasVisaScope } = await resolveVisaTaskAnchor(tx, items, order.visaStatus);
  return {
    orderNumber: order.orderNumber,
    visaStatus: order.visaStatus,
    status: order.status,
    deletedAt: order.deletedAt,
    inactive,
    needed:
      !inactive && orderNeedsVisaTask({ visaStatus: order.visaStatus, hasVisaScope, passengers }),
    anchorItemId,
    passengerCount: passengers.length,
    visaTasks: items.flatMap((item) =>
      item.fulfillmentTasks
        .filter((t) => t.type === FulfillmentType.VISA_APPLICATION)
        .map((t) => ({ id: t.id, status: t.status })),
    ),
  };
}

/** syncVisaTasksForOrder 的执行结果（供调用方审计/回显，脚本按此打印清单）。 */
export interface VisaTaskSyncResult {
  /** 重算后的权威判定：本单还要不要我方代办签证。 */
  needed: boolean;
  /** 本次被自动撤销（PENDING → CANCELLED）的签证任务 id。 */
  cancelledTaskIds: string[];
  /** 本次被自动补建（PENDING）的签证任务 id。 */
  createdTaskIds: string[];
}

/**
 * 签证任务事件驱动同步 —— 「需求变了，任务跟着变」。
 *
 * 背景：建任务的三条路径（建单 createVisaTaskAtCreation / PAID createFulfillmentTasks /
 * 补录地面项 addGroundItem）全是**只补不删**。于是把订单改成「不需要签证」、或把乘客全部
 * 改成自备签之后，早先建的那条 PENDING 任务还挂在签证台上，签证岗看到的是一条永远办不掉的
 * 「待处理」——点进去还是零乘客（签证台按 visaExempt=false 过滤乘客展示）。
 *
 * 本函数按 visa-need.ts 的权威口径（orderNeedsVisaTask：订单级需签 或 商品级涉签，且至少
 * 一位乘客要我方代办）重算，并把任务对齐到这个结论：
 *   - 不需要 → 该单**仅 PENDING（还没人动手）**的签证任务置 CANCELLED；
 *     IN_PROGRESS / CONFIRMED / FAILED 一律不碰（已经在办、或已出结果的活不能被系统悄悄抹掉，
 *     要撤得由签证岗自己判断）；CANCELLED 本就是终态，同样不碰。
 *   - 需要但一条「活动」任务都没有 → 按与建单同一套锚点逻辑补建一条 PENDING。
 *
 * 幂等：结论与现状一致时零写入；重复调用不会重复建、也不会把同一条任务撤两次
 *（updateMany 的 where 二次卡 status=PENDING，与并发的签证岗接单严格串行）。
 *
 * 事务：接受 tx（挂接点都在各自事务内调用，判定与写入之间没有窗口）。审计走全局 prisma
 * 的 fire-and-forget（与本文件其它审计同款），**不进业务事务**——事务回滚时审计不回滚，
 * 宁可多一条「系统撤了任务」的记录，也不要主流程被审计写入拖挂。
 */
export async function syncVisaTasksForOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  actor?: { userId?: string; label?: string; role?: UserRole | 'SYSTEM' },
): Promise<VisaTaskSyncResult> {
  const empty: VisaTaskSyncResult = { needed: false, cancelledTaskIds: [], createdTaskIds: [] };
  const state = await evaluateOrderVisaTaskState(tx, orderId);
  if (!state) return empty;
  const { needed, anchorItemId, visaTasks, passengerCount } = state;

  if (!needed) {
    const pendingIds = visaTasks
      .filter((t) => t.status === FulfillmentStatus.PENDING)
      .map((t) => t.id);
    if (pendingIds.length === 0) return { ...empty, needed: false };
    await tx.fulfillmentTask.updateMany({
      // where 再卡一次 PENDING：判定与写入之间若有签证岗并发接单（PENDING→IN_PROGRESS），
      // 这条 update 自然落空，绝不把「已经在办」的活撤掉。
      where: { id: { in: pendingIds }, status: FulfillmentStatus.PENDING },
      data: { status: FulfillmentStatus.CANCELLED },
    });
    void writeAudit({
      actor: { role: 'SYSTEM', ...actor },
      action: 'VISA_TASK_AUTO_CANCELLED',
      targetType: AuditTargetType.ORDER,
      targetId: orderId,
      targetLabel: state.orderNumber,
      after: {
        reason: '订单已不需要我方代办签证（订单级签证状态改为不需要 / 全员自备签）',
        taskIds: pendingIds,
        visaStatus: state.visaStatus,
        passengerCount,
      },
      severity: AuditSeverity.INFO,
    });
    return { needed: false, cancelledTaskIds: pendingIds, createdTaskIds: [] };
  }

  // 需要签证：已有任一「活动」任务（非 CANCELLED）就什么都不做——幂等，且不与
  // 签证岗手上正在办的那条抢。CANCELLED 视为不存在（可能正是上一轮本函数撤的），
  // 需求改回来时按锚点重新补建一条 PENDING，而不是去复活终态任务。
  const hasActiveVisaTask = visaTasks.some((t) => t.status !== FulfillmentStatus.CANCELLED);
  if (hasActiveVisaTask || !anchorItemId) return { ...empty, needed: true };

  // 补建前贴身再查一次「活动任务」（同事务内 re-check）：上面那次读发生在整段判定的开头，
  // 期间的并发同步（两个请求同时改签证状态 / 改备注与换人并发）可能已经补建过一条。
  // 库上没有唯一约束（迁移成本大），这道 re-check 把「都读到无任务 → 各建一条」的窗口
  // 收到最小；调用方另把撤/建整段放进一个 $transaction，进一步缩短窗口。
  const activeNow = await tx.fulfillmentTask.findFirst({
    where: {
      type: FulfillmentType.VISA_APPLICATION,
      status: { not: FulfillmentStatus.CANCELLED },
      orderItem: { orderId },
    },
    select: { id: true },
  });
  if (activeNow) return { ...empty, needed: true };

  const task = await tx.fulfillmentTask.create({
    data: {
      orderItemId: anchorItemId,
      type: FulfillmentType.VISA_APPLICATION,
      status: FulfillmentStatus.PENDING,
    },
  });
  void writeAudit({
    actor: { role: 'SYSTEM', ...actor },
    action: 'VISA_TASK_AUTO_RECREATED',
    targetType: AuditTargetType.ORDER,
    targetId: orderId,
    targetLabel: state.orderNumber,
    after: {
      reason: '订单重新需要我方代办签证，已补建待处理签证任务',
      taskIds: [task.id],
      visaStatus: state.visaStatus,
      passengerCount,
    },
    severity: AuditSeverity.INFO,
  });
  return { needed: true, cancelledTaskIds: [], createdTaskIds: [task.id] };
}
