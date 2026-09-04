/**
 * 拆单 · 按 kind 的「搬移策略」（纯函数层，不碰 DB、不重新定价）
 *
 * 拆单的顶层哲学（与 per-pax-share.ts 同源）：
 *   1. **搬钱不算钱**：unitPrice 全冻结，只动 quantity / roomsBilled / 显式差额行；
 *   2. **绝不动库存**：座位、房量、升舱人数拆前拆后逐维度 Σ 恒等；
 *   3. **fail-closed**：任何守恒断言不平即抛错回滚。
 *
 * 本模块只回答一个问题：「这一行，拆的时候怎么搬？」——留守侧改哪些字段、拆出侧建什么行。
 * 事务内核（orders.service 的 executeSplitWithinTx）只负责：锁 → 闸 → 建单 → 遍历策略 →
 * 落库 → 平账 → 搬钱 → 任务 → 断言。两边职责分开之后，「口径」全部可以脱离 Prisma 单测。
 *
 * 份额引擎（每人分多少钱）住在 per-pax-share.ts，与本模块正交：行怎么搬**不影响**两侧 total
 *（两侧各补一条 SPLIT 平账行收敛到份额口径）。本模块决定的是成本、房量、座位、升舱、
 * 套餐人数快照这些**派生账**怎么分。
 */
import { OrderItemKind } from '@prisma/client';
import { stripInternalLegPrefix } from './orders.leg-status.js';

// ── 通用小工具 ──────────────────────────────────────────────────────────────
const round2 = (n: number): number => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);
const toInt = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};
const toNum = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** 0.5 网格取整（房数的唯一合法粒度）。 */
export function roundHalfGrid(rooms: number): number {
  return Math.round(rooms * 2) / 2;
}

/** 防御式读 JSON 对象（形状不符按空对象处理）。 */
export function readJsonRecord(raw: unknown): Record<string, unknown> {
  return raw != null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

// ── 跨单继承 metadata 的口径（原住在 orders.service，随策略层一并搬来）────────────
/**
 * 跨单复制订单行 metadata 时必须**剔除**的「会话 / 座位账快照」键。
 *
 * 这些快照记的是「这一行在**这张单上**发生过什么」，跟着行复制到新单会出两种事故：
 *   · requestToken 跨单重复 —— 新单再调 no-show / 取消航段，会命中回放分支，什么都不做却回成功；
 *   · releasedSeats 跟着走 —— 新单点「恢复回程」会照源单的放座明细再占一遍座（凭空多占）。
 * 拆出的新单从零开始：要标 no-show 就在新单上重新标一次。
 *
 * legActionLog 是幂等回放的**主**依据（append-only 的 token 流水）：漏掉它就等于把源单见过的
 * 全部 token 一次性搬到新单，新单上任何一次 no-show / 恢复只要复用了源单用过的 token 就会被判成
 * 重试直接回放 —— 座位一座没动却回成功，最难查。
 */
export const NON_INHERITABLE_ITEM_METADATA_KEYS: readonly string[] = [
  'noShow',
  'returnReleased',
  'returnRestored',
  'returnVoidedFinal',
  'returnLegCancelled',
  'legActionLog',
];

/** 拆单复制行 metadata：显式剔除上面那批快照键，其余原样继承。 */
export function inheritableItemMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (NON_INHERITABLE_ITEM_METADATA_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/** 这一行的 metadata 上带着航段会话快照吗（= 继承时会被 inheritableItemMetadata 剥掉）。 */
export function hasStrippableLegSnapshot(metadata: Record<string, unknown>): boolean {
  return NON_INHERITABLE_ITEM_METADATA_KEYS.some((key) => metadata[key] != null);
}

/**
 * 这一段航班是否已经走到**终态**：回程过期作废（returnVoidedFinal）或取消航段（returnLegCancelled）。
 * 两者的共同点是「班次已置空、钱已按取消政策结清、座位早已还回库存」，这一行只剩一具留痕残骸。
 */
export function isTerminalLegItem(metadata: Record<string, unknown>): boolean {
  return metadata.returnVoidedFinal != null || metadata.returnLegCancelled != null;
}

/**
 * 拆单时新行的描述：**剥掉了快照就一并剥掉描述上的内部留痕前缀**。
 *
 * 描述前缀（【去程未登机】/【回程座位已释放】…）和 metadata 快照是一对。继承时快照被剥掉、
 * 前缀却跟着复制，新单上就会出现一行「【回程座位已释放】…」但 metadata 里什么都没有 ——
 * 运营只看得到那行字，以为这段还释放着。没有快照可剥的行描述原样保留。
 */
export function splitInheritedDescription(
  description: string,
  metadata: Record<string, unknown>,
): string {
  return hasStrippableLegSnapshot(metadata) ? stripInternalLegPrefix(description) : description;
}

// ── 策略层的输入 / 输出形状 ─────────────────────────────────────────────────
/** 一侧（拆出 / 留守）的占座模型计数，由 Passenger.passengerType 派生。 */
export interface SplitOccupancy {
  adultCount: number;
  childCount: number;
  infantCount: number;
  /** 占座人数 = adult + child（婴儿不占座、不占房、不计操作费） */
  seatPax: number;
  /** 出行人数 = adult + child + infant */
  headCount: number;
}

/** 乘客名册 → 一侧的占座计数。 */
export function occupancyOfPassengers(
  passengers: ReadonlyArray<{ passengerType?: string | null }>,
): SplitOccupancy {
  let adultCount = 0;
  let childCount = 0;
  let infantCount = 0;
  for (const p of passengers) {
    if (p.passengerType === 'CHILD') childCount += 1;
    else if (p.passengerType === 'INFANT') infantCount += 1;
    else adultCount += 1;
  }
  return {
    adultCount,
    childCount,
    infantCount,
    seatPax: adultCount + childCount,
    headCount: adultCount + childCount + infantCount,
  };
}

/** 拆单上下文：一次拆单里所有策略共享的「两侧人数与显式指令」。 */
export interface SplitContext {
  movedIdSet: ReadonlySet<string>;
  /** 拆出人数 */
  k: number;
  /** 拆前全员人数 */
  totalPax: number;
  movedSeatPax: number;
  totalSeatPax: number;
  movedOccupancy: SplitOccupancy;
  keptOccupancy: SplitOccupancy;
  /** 单住乘客数（Passenger.singleRoom） */
  movedSingleCount: number;
  keptSingleCount: number;
  /** 自备签乘客数（Passenger.visaExempt） */
  movedSelfVisaCount: number;
  keptSelfVisaCount: number;
  /** 显式 roomSplit：行 id → 随拆搬走的间数（0.5 网格） */
  roomSplitByItem: ReadonlyMap<string, number>;
  /** 已解析的升舱拆分：FLIGHT 行 id → 随拆搬走的升舱人数 */
  upgradeSplitByItem: ReadonlyMap<string, number>;
  /** 套餐行 addOns 重建用：两侧的分程升舱人数（由 FLIGHT 行拆分结果汇总） */
  movedUpgradeOutbound: number;
  movedUpgradeReturn: number;
  keptUpgradeOutbound: number;
  keptUpgradeReturn: number;
  /**
   * 未显式给 roomSplit 时是否自动派生房数（no-show / 按人改期编排传 true；
   * 手工拆单默认 false —— 酒店行不动，运营自己在弹窗里填间数）。
   */
  autoDeriveRooms: boolean;
  /**
   * 本次拆单的配对令牌（= requestToken）。住宿行被劈成两个半间时，两侧写同一个
   * `splitPairKey`（源行 id + 本令牌），房控据此把跨单的两个半间**配回一间** ——
   * 否则「一间房拆成两张单的两个半间」会被物理口径数成两间，凭空多占房。
   * 建议值上下文（预检回显）传空串 = 不写配对键（预检不落库）。
   */
  splitPairToken: string;
}

/**
 * 住宿行随拆劈半时两侧共用的配对键：`源行 id:拆单令牌`。
 * 令牌为空（预检建议上下文）→ 返回 null，调用方不写这个键。
 */
export function splitPairKeyOf(itemId: string, ctx: SplitContext): string | null {
  return ctx.splitPairToken ? `${itemId}:${ctx.splitPairToken}` : null;
}

/** 策略要读的订单行最小形状（真实入参是 loadOrderForSplit 读出来的行）。 */
export interface SplitItemView {
  id: string;
  kind: OrderItemKind;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  totalCostCny: number | null;
  roomsBilled: number | null;
  passengerId: string | null;
  metadata: Record<string, unknown>;
}

/** 一侧要落库的字段补丁（只列出真正需要改/建的列，其余由内核复制源行）。 */
export interface SplitRowPatch {
  description?: string;
  quantity?: number;
  amount?: number;
  totalCostCny?: number | null;
  roomsBilled?: number | null;
  metadata?: Record<string, unknown>;
}

/** 搬移决策：不动 / 整行搬走 / 拆成两行。 */
export type SplitMove =
  | { mode: 'NONE' }
  | { mode: 'WHOLE'; update: SplitRowPatch }
  | { mode: 'SPLIT'; keep: SplitRowPatch; move: SplitRowPatch };

/** 该行 metadata 上记的升舱人数（无该键 → 0）。 */
export function readUpgradeCount(metadata: Record<string, unknown>): number {
  return Math.max(0, toInt(metadata.businessUpgradeCount, 0));
}

// ── 策略 1：按人数行（FLIGHT / VISA / TRANSFER）──────────────────────────────
/**
 * 这一行随拆搬走几件 —— **按各自 quantity 的语义取分母**，不能一律用「拆出人头数」。
 *
 *   · FLIGHT：quantity 是**占座数**（婴儿不占座，压根不出现在这一行的 quantity 里）
 *     → 用拆出侧占座人数 `movedSeatPax`；
 *   · VISA / TRANSFER：按人头计费（婴儿一样要办签、一样要坐车，quantity 含婴儿）
 *     → 仍用拆出人头数 `k`。
 *
 * 混用过一次就是事故：2 大 1 婴的单（机票行 quantity = 2），拆「大人 A + 婴儿」时
 * k = 2 ≥ quantity = 2 会被判成「整行搬走」—— 留守那位大人的机票行连座位一起被搬到新单，
 * 源单剩着一位客人却一条航段行都没有。
 */
export function movedUnitsFor(item: SplitItemView, ctx: SplitContext): number {
  const demand = item.kind === OrderItemKind.FLIGHT ? ctx.movedSeatPax : ctx.k;
  return Math.min(item.quantity, Math.max(0, demand));
}

/**
 * quantity 就是人数：拆出 min(quantity, 本行的拆出需求) 件；需求 ≥ quantity → 整行搬走。
 * 「拆出需求」按该行 quantity 的语义取（见 movedUnitsFor：机票看占座数、签证/接送看人头）。
 * 升舱人数（metadata.businessUpgradeCount）随之按显式指令或人头比例拆开 ——
 * 它是**真实商务舱座位**的镜像账，拆散了退座会还错舱位，故必须两侧各记各的。
 */
export function moveFlightLike(item: SplitItemView, ctx: SplitContext): SplitMove {
  const moveQty = movedUnitsFor(item, ctx);
  if (moveQty <= 0) return { mode: 'NONE' };
  const md = item.metadata;
  if (moveQty >= item.quantity) {
    // 整行过户也要剥掉会话级快照（幂等 token 与放座明细），描述前缀与快照成对剥。
    return {
      mode: 'WHOLE',
      update: {
        description: splitInheritedDescription(item.description, md),
        metadata: inheritableItemMetadata(md),
      },
    };
  }
  const keepQty = item.quantity - moveQty;
  const upgradeCount = readUpgradeCount(md);
  const movedUpgrade = resolveUpgradeToMove(item, ctx, moveQty, keepQty);
  const keptUpgrade = upgradeCount - movedUpgrade;

  const srcCost = item.totalCostCny;
  const movedCost = srcCost == null ? null : round2((srcCost * moveQty) / item.quantity);
  const keptCost = srcCost == null || movedCost == null ? null : round2(srcCost - movedCost);

  const keepMeta = { ...md };
  const moveMeta: Record<string, unknown> = {
    ...inheritableItemMetadata(md),
    splitFromItemId: item.id,
  };
  if (md.businessUpgradeCount != null) {
    keepMeta.businessUpgradeCount = keptUpgrade;
    moveMeta.businessUpgradeCount = movedUpgrade;
  }

  return {
    mode: 'SPLIT',
    keep: {
      quantity: keepQty,
      amount: round2(item.unitPrice * keepQty),
      totalCostCny: keptCost,
      ...(md.businessUpgradeCount != null ? { metadata: keepMeta } : {}),
    },
    move: {
      description: splitInheritedDescription(item.description, md),
      quantity: moveQty,
      amount: round2(item.unitPrice * moveQty),
      totalCostCny: movedCost,
      metadata: moveMeta,
    },
  };
}

/**
 * 这一行随拆搬走几个升舱位。
 *   · 显式 upgradeSplit → 照办（越界由内核在校验段拒掉，这里再夹一次兜底）；
 *   · 未显式 → 自动派生 = min(count, round(count × 拆出占座 / 全员占座))，且 ≤ 拆出占座人数；
 *   · 两侧都夹在 [count − keepQty, min(count, moveQty)]：一侧不能记比自己座位还多的升舱位。
 */
export function resolveUpgradeToMove(
  item: SplitItemView,
  ctx: SplitContext,
  moveQty: number,
  keepQty: number,
): number {
  const count = readUpgradeCount(item.metadata);
  if (count <= 0) return 0;
  const hi = Math.min(count, moveQty);
  const lo = Math.max(0, count - keepQty);
  const explicit = ctx.upgradeSplitByItem.get(item.id);
  if (explicit != null) return clamp(Math.trunc(explicit), lo, hi);
  const totalSeat = ctx.totalSeatPax > 0 ? ctx.totalSeatPax : ctx.totalPax;
  const movedSeat = ctx.totalSeatPax > 0 ? ctx.movedSeatPax : ctx.k;
  const derived = totalSeat > 0 ? Math.round((count * movedSeat) / totalSeat) : 0;
  return clamp(Math.min(derived, movedSeat), lo, hi);
}

// ── 策略 2：酒店行 ─────────────────────────────────────────────────────────
/**
 * 房数按 0.5 网格拆（拼房半间口径：没来的人带走自己那半间和那份钱，
 * 两张单同酒店同房型同日期，房控把两个半间配回一间，房量不变）。
 * 金额与成本按 **间数比例** 拆 —— 房费本来就是按间收的。
 */
export function moveHotel(item: SplitItemView, ctx: SplitContext): SplitMove {
  const srcRooms = item.roomsBilled;
  if (srcRooms == null || srcRooms <= 0) return { mode: 'NONE' };
  const moveRooms = resolveRoomsToMove(item, ctx, srcRooms);
  if (moveRooms == null || moveRooms <= 0) return { mode: 'NONE' };
  const srcHalf = Math.round(srcRooms * 2);
  const moveHalf = Math.round(moveRooms * 2);
  if (moveHalf >= srcHalf) return { mode: 'WHOLE', update: {} };

  const srcAmount = item.amount;
  const movedAmount = round2((srcAmount * moveHalf) / srcHalf);
  const srcCost = item.totalCostCny;
  const movedCost = srcCost == null ? null : round2((srcCost * moveHalf) / srcHalf);
  const keptCost = srcCost == null || movedCost == null ? null : round2(srcCost - movedCost);
  // 配对键：两侧写同一个 key，房控把跨单的两个半间配回一间（不看性别）。
  const pairKey = splitPairKeyOf(item.id, ctx);
  return {
    mode: 'SPLIT',
    keep: {
      roomsBilled: (srcHalf - moveHalf) / 2,
      amount: round2(srcAmount - movedAmount),
      totalCostCny: keptCost,
      ...(pairKey ? { metadata: { ...item.metadata, splitPairKey: pairKey } } : {}),
    },
    move: {
      roomsBilled: moveHalf / 2,
      amount: movedAmount,
      totalCostCny: movedCost,
      metadata: {
        ...inheritableItemMetadata(item.metadata),
        splitFromItemId: item.id,
        ...(pairKey ? { splitPairKey: pairKey } : {}),
      },
    },
  };
}

/** 该行随拆搬走几间：显式 roomSplit 优先；未显式且允许自动派生时按人头派生。 */
export function resolveRoomsToMove(
  item: SplitItemView,
  ctx: SplitContext,
  srcRooms: number,
): number | null {
  const explicit = ctx.roomSplitByItem.get(item.id);
  if (explicit != null) return roundHalfGrid(explicit);
  if (!ctx.autoDeriveRooms) return null;
  return deriveRoomsToMove(srcRooms, ctx);
}

/**
 * 房数自动派生（0.5 粒度）：
 *   基线 = round_half(源行间数 × 拆出占座 / 全员占座)；
 *   单住乘客整间带走（movedSingleCount 间的下限）、留守单住整间留下（上限）；
 *   两侧都还有人时各留至少半间（不出现「一侧 0 间却住着人」）。
 * 拆后两侧 Σ = 源行间数（内核有 Σ roomsBilled 守恒断言兜底）。
 */
export function deriveRoomsToMove(srcRooms: number, ctx: SplitContext): number {
  const srcHalf = Math.round(srcRooms * 2);
  if (srcHalf <= 0) return 0;
  const totalSeat = ctx.totalSeatPax > 0 ? ctx.totalSeatPax : ctx.totalPax;
  const movedSeat = ctx.totalSeatPax > 0 ? ctx.movedSeatPax : ctx.k;
  const keptSeat = totalSeat - movedSeat;
  if (totalSeat <= 0) return 0;

  let movedHalf = Math.round((srcHalf * movedSeat) / totalSeat);
  // 单住乘客整间：拆出侧至少这么多、留守侧也至少这么多。
  movedHalf = Math.max(movedHalf, Math.min(ctx.movedSingleCount * 2, srcHalf));
  movedHalf = Math.min(
    movedHalf,
    Math.max(0, srcHalf - Math.min(ctx.keptSingleCount * 2, srcHalf)),
  );
  // 两侧都有人 → 各留至少半间（srcHalf < 2 时无从各留，跳过该约束）。
  if (movedSeat > 0 && keptSeat > 0 && srcHalf >= 2) movedHalf = clamp(movedHalf, 1, srcHalf - 1);
  return clamp(movedHalf, 0, srcHalf) / 2;
}

// ── 策略 3：套餐行（BUNDLE）────────────────────────────────────────────────
/**
 * 套餐行 quantity 恒为 1（份数，不是人数），amount 是「整团地面价 + 加项 + 指定酒店加价 +
 * 操作费」再 percent-off 后的一口价。故按 **占座人数比例** r 劈金额与成本（婴儿不占座、
 * 不占房、不计操作费，故不进 r 的分母），quantity 两侧仍各为 1。
 *
 * 人数快照（metadata.addOns）**按乘客现势重建**而不是照抄：抄过去两边都写着 3 人，
 * 之后任一侧改档（changeOrderBundle 直接读 addOns 定价）就会按 3 人算钱。
 */
export function moveBundle(item: SplitItemView, ctx: SplitContext): SplitMove {
  const totalSeat = ctx.totalSeatPax > 0 ? ctx.totalSeatPax : ctx.totalPax;
  const movedSeat = ctx.totalSeatPax > 0 ? ctx.movedSeatPax : ctx.k;
  const r = totalSeat > 0 ? movedSeat / totalSeat : 0;
  // 成本份额：只拆婴儿时占座比 r === 0，成本会整块留在源单 —— 婴儿也吃地接成本，
  // 按人头比例（k / 全员）劈才对得上毛利底账。占座比非 0 时两者同源，不改现有口径。
  const costRatio = movedSeat > 0 ? r : ctx.totalPax > 0 ? ctx.k / ctx.totalPax : 0;

  const movedAmount = round2(item.amount * r);
  const keptAmount = round2(item.amount - movedAmount);
  const srcCost = item.totalCostCny;
  const movedCost = srcCost == null ? null : round2(srcCost * costRatio);
  const keptCost = srcCost == null || movedCost == null ? null : round2(srcCost - movedCost);

  // 单住 / 自备签计数：乘客表与套餐快照对不上（商城整单口径）时回落到按占座份额劈原快照，
  // 房数下限（单住整间）也吃这个回落值 —— 否则会按「两侧都 0 位单住」派生房数。
  const effCtx = withBundleSideCounts(item, ctx);

  let movedRooms: number | null = null;
  let keptRooms: number | null = null;
  if (item.roomsBilled != null && item.roomsBilled > 0) {
    // 套餐单的住宿盖章就在这条行上：未显式给 roomSplit 也要派生，否则房量会整块留在源单。
    const resolved =
      resolveRoomsToMove(item, effCtx, item.roomsBilled) ??
      deriveRoomsToMove(item.roomsBilled, effCtx);
    const srcHalf = Math.round(item.roomsBilled * 2);
    const moveHalf = clamp(Math.round(resolved * 2), 0, srcHalf);
    movedRooms = moveHalf / 2;
    keptRooms = (srcHalf - moveHalf) / 2;
  }

  const { keep: keepMeta, move: moveMeta } = rebuildBundleMetadataPair(item, effCtx, r, {
    movedRooms,
    keptRooms,
  });
  // 住宿盖章两侧都留了半间 → 写配对键，房控把两个半间配回一间（口径同 moveHotel）。
  const pairKey =
    movedRooms != null && keptRooms != null && movedRooms > 0 && keptRooms > 0
      ? splitPairKeyOf(item.id, ctx)
      : null;

  return {
    mode: 'SPLIT',
    keep: {
      amount: keptAmount,
      totalCostCny: keptCost,
      ...(keptRooms != null ? { roomsBilled: keptRooms } : {}),
      metadata: pairKey ? { ...keepMeta, splitPairKey: pairKey } : keepMeta,
    },
    move: {
      description: item.description,
      quantity: 1,
      amount: movedAmount,
      totalCostCny: movedCost,
      ...(movedRooms != null ? { roomsBilled: movedRooms } : {}),
      metadata: {
        ...moveMeta,
        splitFromItemId: item.id,
        ...(pairKey ? { splitPairKey: pairKey } : {}),
      },
    },
  };
}

/**
 * 套餐行两侧的单住 / 自备签人数：乘客表标记优先，与套餐快照对不上时按占座份额劈快照。
 *
 * 为什么要回落：前台商城单是**整单口径**下的单（addOns.singleCount / selfProvidedVisaCount
 * 记在套餐行上），乘客表里一个 singleRoom / visaExempt 标记都没有。照乘客表重建，两侧
 * singleCount 都会变成 0 —— 单房差凭空蒸发，房数派生也失去「单住整间」的下限。
 * 回落口径：moved = round(原快照 × 拆出占座 / 全员占座)（夹进两侧座位数），kept = 原 − moved，
 * 两侧 Σ 恒等于原快照。
 */
export function withBundleSideCounts(item: SplitItemView, ctx: SplitContext): SplitContext {
  const addOns = readJsonRecord(item.metadata.addOns);
  const totalSeat = ctx.totalSeatPax > 0 ? ctx.totalSeatPax : ctx.totalPax;
  const movedSeat = ctx.totalSeatPax > 0 ? ctx.movedSeatPax : ctx.k;
  const share = (orig: number, movedCap: number, keptCap: number): [number, number] => {
    const derived = totalSeat > 0 ? Math.round((orig * movedSeat) / totalSeat) : 0;
    const moved = clamp(derived, Math.max(0, orig - keptCap), Math.min(orig, movedCap));
    return [moved, orig - moved];
  };

  let movedSingleCount = ctx.movedSingleCount;
  let keptSingleCount = ctx.keptSingleCount;
  const origSingle = Math.max(0, toInt(addOns.singleCount, 0));
  if (addOns.singleCount != null && movedSingleCount + keptSingleCount !== origSingle) {
    [movedSingleCount, keptSingleCount] = share(
      origSingle,
      ctx.movedOccupancy.seatPax,
      ctx.keptOccupancy.seatPax,
    );
  }

  let movedSelfVisaCount = ctx.movedSelfVisaCount;
  let keptSelfVisaCount = ctx.keptSelfVisaCount;
  const origSelfVisa = Math.max(0, toInt(addOns.selfProvidedVisaCount, 0));
  if (
    addOns.selfProvidedVisaCount != null &&
    movedSelfVisaCount + keptSelfVisaCount !== origSelfVisa
  ) {
    [movedSelfVisaCount, keptSelfVisaCount] = share(
      origSelfVisa,
      ctx.movedOccupancy.headCount,
      ctx.keptOccupancy.headCount,
    );
  }

  if (
    movedSingleCount === ctx.movedSingleCount &&
    keptSingleCount === ctx.keptSingleCount &&
    movedSelfVisaCount === ctx.movedSelfVisaCount &&
    keptSelfVisaCount === ctx.keptSelfVisaCount
  ) {
    return ctx;
  }
  return { ...ctx, movedSingleCount, keptSingleCount, movedSelfVisaCount, keptSelfVisaCount };
}

/**
 * 套餐行 metadata 两侧重建。
 *   · addOns：按各侧乘客现势重算（计数按人算、费率与 nights/legs 原样、小计 = 新计数 × 原费率）；
 *   · roomsNeeded：跟随各侧 roomsBilled；
 *   · designatedHotel / operationFee：整行合计按份额缩放，Σ 恒等（kept = 原 − moved）；
 *   · visaListSnapshotCny：每人口径，两侧原样继承，不缩放；
 *   · 顶层 adultCount/childCount/infantCount/pax（老单无 addOns 时的回落口径）同步刷新。
 */
export function rebuildBundleMetadataPair(
  item: SplitItemView,
  ctx: SplitContext,
  r: number,
  rooms: { movedRooms: number | null; keptRooms: number | null },
): { keep: Record<string, unknown>; move: Record<string, unknown> } {
  const base = inheritableItemMetadata(item.metadata);
  const keep: Record<string, unknown> = { ...base };
  const move: Record<string, unknown> = { ...base };

  // ① 人数快照
  const origAddOns = base.addOns;
  if (origAddOns != null && typeof origAddOns === 'object' && !Array.isArray(origAddOns)) {
    const orig = origAddOns as Record<string, unknown>;
    move.addOns = rebuildAddOns(orig, {
      occupancy: ctx.movedOccupancy,
      singleCount: ctx.movedSingleCount,
      selfVisaCount: ctx.movedSelfVisaCount,
      upgradeOutbound: ctx.movedUpgradeOutbound,
      upgradeReturn: ctx.movedUpgradeReturn,
      rooms: rooms.movedRooms,
    });
    keep.addOns = rebuildAddOns(orig, {
      occupancy: ctx.keptOccupancy,
      singleCount: ctx.keptSingleCount,
      selfVisaCount: ctx.keptSelfVisaCount,
      upgradeOutbound: ctx.keptUpgradeOutbound,
      upgradeReturn: ctx.keptUpgradeReturn,
      rooms: rooms.keptRooms,
    });
  }
  // 顶层三计数（无 addOns 的老单靠它回落）
  if (base.adultCount != null || base.childCount != null || base.infantCount != null) {
    move.adultCount = ctx.movedOccupancy.adultCount;
    move.childCount = ctx.movedOccupancy.childCount;
    move.infantCount = ctx.movedOccupancy.infantCount;
    keep.adultCount = ctx.keptOccupancy.adultCount;
    keep.childCount = ctx.keptOccupancy.childCount;
    keep.infantCount = ctx.keptOccupancy.infantCount;
  }
  if (base.pax != null) {
    move.pax = ctx.movedOccupancy.headCount;
    keep.pax = ctx.keptOccupancy.headCount;
  }

  // ② 占房间数
  if (base.roomsNeeded != null) {
    if (rooms.movedRooms != null) move.roomsNeeded = rooms.movedRooms;
    if (rooms.keptRooms != null) keep.roomsNeeded = rooms.keptRooms;
  }

  // ③ 整行快照按份额缩放（kept = 原 − moved，Σ 恒等）
  const designated = base.designatedHotel;
  if (designated != null && typeof designated === 'object' && !Array.isArray(designated)) {
    const orig = designated as Record<string, unknown>;
    const origTotal = toNum(orig.totalCny, 0);
    const movedTotal = round2(origTotal * r);
    move.designatedHotel = { ...orig, pax: ctx.movedOccupancy.seatPax, totalCny: movedTotal };
    keep.designatedHotel = {
      ...orig,
      pax: ctx.keptOccupancy.seatPax,
      totalCny: round2(origTotal - movedTotal),
    };
  }
  const opFee = base.operationFee;
  if (opFee != null && typeof opFee === 'object' && !Array.isArray(opFee)) {
    const orig = opFee as Record<string, unknown>;
    const origTotal = toNum(orig.totalCny, 0);
    const movedTotal = round2(origTotal * r);
    move.operationFee = { ...orig, pax: ctx.movedOccupancy.seatPax, totalCny: movedTotal };
    keep.operationFee = {
      ...orig,
      pax: ctx.keptOccupancy.seatPax,
      totalCny: round2(origTotal - movedTotal),
    };
  }
  // visaListSnapshotCny 是**每人**口径（下单时套餐定义 VISA 组件 qty×unitPrice，与
  // bundle-pricing 的 visaPerPax 同源；导出侧 perPaxVisaAmountByPassenger 也按每人读），
  // 不是整行合计 —— 两侧原样继承（base 已带），不按份额缩放；缩放会让拆后两边的签证金额都偏低。
  return { keep, move };
}

/**
 * addOns 明细按一侧的乘客现势重算（费率 / nights / legs 原样，小计 = 新计数 × 原费率）。
 * `side.rooms` 给这一侧实际盖章的计费房数（roomsBilled）：addOns.rooms 必须跟着它走
 * （= ceil(roomsBilled)），否则「按人头猜的间数」与订单行的房量两本账会分叉。
 */
export function rebuildAddOns(
  orig: Record<string, unknown>,
  side: {
    occupancy: SplitOccupancy;
    singleCount: number;
    selfVisaCount: number;
    upgradeOutbound: number;
    upgradeReturn: number;
    rooms?: number | null;
  },
): Record<string, unknown> {
  const occ = side.occupancy;
  const nights = Math.max(1, toInt(orig.nights, 1));
  const legs = Math.max(1, toInt(orig.legs, 1));
  const singleRate = Math.max(0, toNum(orig.singleSupplementCnyPerNight, 0));
  const businessRate = Math.max(0, toNum(orig.businessUpgradeCnyPerLeg, 0));
  const childRate = Math.max(0, toNum(orig.childSeatDiscountCnyPerPerson, 0));
  const infantRate = Math.max(0, toNum(orig.infantPriceCny, 0));
  const selfVisaRate = Math.max(0, toNum(orig.selfVisaDeductCny, 0));

  const singleCount = clamp(Math.trunc(side.singleCount), 0, occ.seatPax);
  const selfVisaCount = clamp(Math.trunc(side.selfVisaCount), 0, occ.headCount);
  const businessCountOutbound = clamp(Math.trunc(side.upgradeOutbound), 0, occ.seatPax);
  const businessCountReturn = legs >= 2 ? clamp(Math.trunc(side.upgradeReturn), 0, occ.seatPax) : 0;
  const businessCount = Math.max(businessCountOutbound, businessCountReturn);

  const singleSupplementTotal = singleCount * singleRate * nights;
  const businessUpgradeTotal = (businessCountOutbound + businessCountReturn) * businessRate;
  const childSeatDiscountTotal = occ.childCount * childRate;
  const infantPriceTotal = occ.infantCount * infantRate;
  const selfVisaDeductTotal = selfVisaCount * selfVisaRate;

  return {
    ...orig,
    singleCount,
    businessCount,
    businessCountOutbound,
    businessCountReturn,
    adultCount: occ.adultCount,
    childCount: occ.childCount,
    infantCount: occ.infantCount,
    seatPax: occ.seatPax,
    headCount: occ.headCount,
    rooms:
      side.rooms != null && side.rooms > 0
        ? Math.ceil(side.rooms)
        : Math.ceil(occ.seatPax / 2),
    nights,
    legs,
    singleSupplementCnyPerNight: singleRate,
    businessUpgradeCnyPerLeg: businessRate,
    childSeatDiscountCnyPerPerson: childRate,
    infantPriceCny: infantRate,
    selfProvidedVisaCount: selfVisaCount,
    selfProvidedVisa: selfVisaCount > 0,
    selfVisaDeductCny: selfVisaRate,
    singleSupplementTotal,
    businessUpgradeTotal,
    childSeatDiscountTotal,
    infantPriceTotal,
    selfVisaDeductTotal,
    total:
      singleSupplementTotal +
      businessUpgradeTotal +
      infantPriceTotal -
      childSeatDiscountTotal -
      selfVisaDeductTotal,
  };
}

// ── 策略 4：调价 / 折扣行 ───────────────────────────────────────────────────
/**
 * 调价行（metadata.priceAdjustment === true）：
 *   · 按人调整行（passengerId 非空）→ 跟人走（整行搬 / 整行留）；
 *   · 套餐改档差额行（metadata.bundleChange === true）→ 按份额劈成两行，两侧各保留身份标
 *     （下一次改档要靠它把历次差额加回基线，只留一侧会让另一侧的基线漂掉）；
 *   · 其余整单调整行（结算价差额、拆单平账…）→ 全留源单，份额差由 SPLIT 平账行收敛。
 */
export function movePriceAdjustment(item: SplitItemView, ctx: SplitContext): SplitMove {
  if (item.passengerId) {
    return ctx.movedIdSet.has(item.passengerId) ? { mode: 'WHOLE', update: {} } : { mode: 'NONE' };
  }
  if (item.metadata.bundleChange === true) {
    const totalSeat = ctx.totalSeatPax > 0 ? ctx.totalSeatPax : ctx.totalPax;
    const movedSeat = ctx.totalSeatPax > 0 ? ctx.movedSeatPax : ctx.k;
    const r = totalSeat > 0 ? movedSeat / totalSeat : 0;
    const movedAmount = round2(item.amount * r);
    if (movedAmount === 0) return { mode: 'NONE' };
    const keptAmount = round2(item.amount - movedAmount);
    return {
      mode: 'SPLIT',
      keep: { amount: keptAmount },
      move: {
        quantity: 1,
        amount: movedAmount,
        totalCostCny: 0,
        metadata: { ...item.metadata, splitFromItemId: item.id },
      },
    };
  }
  return { mode: 'NONE' };
}

/**
 * 同业立减行（metadata.settlementDiscount === true）：按 **占座人数** 拆成两行
 *（立减规则本就按占座人头计，婴儿不占座也不吃立减），描述随之更新。
 */
export function moveDiscount(item: SplitItemView, ctx: SplitContext): SplitMove {
  const perPerson = toNum(item.metadata.discountPerPersonCny, 0);
  const origPax = Math.max(0, toInt(item.metadata.pax, 0));
  if (perPerson <= 0 || origPax <= 0 || ctx.totalPax <= 0) return { mode: 'NONE' };
  const totalSeat = ctx.totalSeatPax > 0 ? ctx.totalSeatPax : ctx.totalPax;
  const movedSeat = ctx.totalSeatPax > 0 ? ctx.movedSeatPax : ctx.k;
  const movedPax = clamp(Math.round((origPax * movedSeat) / totalSeat), 0, origPax);
  if (movedPax <= 0) return { mode: 'NONE' };
  const keptPax = origPax - movedPax;
  const label = (pax: number): string => `同业立减 ¥${perPerson}/人 × ${pax}人`;
  if (keptPax <= 0) {
    return { mode: 'WHOLE', update: { description: label(origPax) } };
  }
  const movedAmount = -round2(perPerson * movedPax);
  const keptAmount = round2(item.amount - movedAmount);
  return {
    mode: 'SPLIT',
    keep: {
      description: label(keptPax),
      amount: keptAmount,
      metadata: { ...item.metadata, pax: keptPax },
    },
    move: {
      description: label(movedPax),
      quantity: 1,
      amount: movedAmount,
      totalCostCny: 0,
      metadata: { ...item.metadata, pax: movedPax, splitFromItemId: item.id },
    },
  };
}

/**
 * 派单入口：一条行 → 一个搬移决策。内核只管照决策落库，不再自己判 kind。
 * 调价 / 折扣行优先于 kind 判定（它们的 kind 是 FEE/DISCOUNT，走的却是完全不同的口径）。
 */
export function planItemMove(item: SplitItemView, ctx: SplitContext): SplitMove {
  if (item.metadata.priceAdjustment === true) {
    return item.metadata.settlementDiscount === true
      ? moveDiscount(item, ctx)
      : movePriceAdjustment(item, ctx);
  }
  // 按人落的签证行（passengerId 非空 = 「这一条是给这位客人办的签」）跟人走：
  // 按 quantity 劈会把「张三那条签证」的钱留在源单、把一条无主的空壳搬到新单。
  if (item.kind === OrderItemKind.VISA && item.passengerId) {
    return ctx.movedIdSet.has(item.passengerId)
      ? {
          mode: 'WHOLE',
          update: {
            description: splitInheritedDescription(item.description, item.metadata),
            metadata: inheritableItemMetadata(item.metadata),
          },
        }
      : { mode: 'NONE' };
  }
  // 已走到终态的航段行（回程过期作废 / 取消航段）**整块留在源单**，不随拆。
  //
  // 为什么不做成拆单闸（blocker）：终态是既成事实、也是常态 —— 一张单里回程被作废掉之后，
  // 剩下的人照样可能要按人改期、按人拆单。拿它拦住拆单等于把这批单永久锁死。
  // 为什么也不能跟着搬：这一行的钱已经按取消政策结清、座位早已还回库存，快照
  //（returnVoidedFinal / returnLegCancelled）又是不可继承的（见 NON_INHERITABLE_ITEM_METADATA_KEYS）。
  // 劈一半过去，新单上会出现一条「没有班次、没有快照、还占着 quantity」的空壳行 ——
  // 运营看不懂、导出对不上、后续任何航段动作都无从下手。留痕留在它发生的那张单上最干净。
  if (item.kind === OrderItemKind.FLIGHT && isTerminalLegItem(item.metadata)) {
    return { mode: 'NONE' };
  }
  if (
    item.kind === OrderItemKind.FLIGHT ||
    item.kind === OrderItemKind.VISA ||
    item.kind === OrderItemKind.TRANSFER
  ) {
    return moveFlightLike(item, ctx);
  }
  if (item.kind === OrderItemKind.HOTEL) return moveHotel(item, ctx);
  if (item.kind === OrderItemKind.BUNDLE) return moveBundle(item, ctx);
  // 其余行（非调整的 FEE/DISCOUNT 等）全留源单：份额差由 SPLIT 平账行收敛。
  return { mode: 'NONE' };
}
