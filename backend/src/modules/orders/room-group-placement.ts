/**
 * 房组「落位名」口径（唯一入口）。
 *
 * 分房表 `Order.roomAssignment.roomGroups[].hotelName / roomType` 是一份**派生文本**：
 * 它照抄归属订单行（HOTEL / 盖章酒店的 BUNDLE 行）当时的落位。行上的落位一变
 * （换酒店 / 套餐改档 / 随机档落位），文本不跟着刷就会与行分叉 —— 而三张导出表的
 * 「酒店」列刻意**优先取房组文本**（跟房控走），分叉直接印进给客户对数的表里。
 *
 * 这里把三件事收成纯函数，售后流程（orders.service）、导出（orders.export-*）、
 * 回填脚本（scripts/backfill-room-group-hotel-name.ts）共用，避免三份口径各自漂移：
 *   1. `resolveRoomGroupPlacement` —— 订单行 → 房组应写的酒店名 / 房型名；
 *      · 真酒店：FK 酒店名 + FK 房型名；
 *      · 随机档（房型挂在占位酒店上，或无 FK 只有 randomStarTier）：「X星随机（待落位）」+「待落位」。
 *   2. `refreshRoomGroupsForItem` —— 把 roomAssignment 里属于某行的房组改写成新落位名
 *      （归属精确匹配优先，无归属组时才走调用方给的旧文本匹配）。
 *   3. `renameBundlePrefixedDescription` —— 套餐改档后，机票行等「以旧套餐名为前缀」的
 *      description 换成新套餐名（只认精确前缀，不匹配就不动）。
 *
 * 本模块**不 import 任何业务模块**（只能被依赖，不依赖别人），保证 orders.service 与导出层
 * 同时引用它时不会形成循环依赖。
 */

/** 未落位行的房型格文案（酒店都没定，房型无从谈起）。*/
export const PENDING_PLACEMENT_ROOM_TYPE = '待落位';

/** randomStarTier（星级随机档）→ 中文星级；枚举外的档次回落「N星」，绝不丢档次信息。*/
const STAR_TIER_CN: Record<number, string> = {
  2: '二星',
  3: '三星',
  4: '四星',
  5: '五星',
  6: '六星',
};

/**
 * 「星级随机」未落位行在分房表 / 导出表 / 房组文本里的酒店格文案：`X星随机（待落位）`。
 * 口径唯一入口 —— 分房表的酒店分组名、《全岗可用》/《签证专用》的「酒店类型」列、
 * 售后刷新与回填写进房组的 hotelName 共用，各处文案必须一致，运营对表时才不会以为是两种东西。
 * tier 为空 → 返回空串（调用方自行决定回落，本函数不编造档次）。
 */
export function randomStarTierLabel(tier: number | null | undefined): string {
  if (tier == null) return '';
  return `${STAR_TIER_CN[tier] ?? `${tier}星`}随机（${PENDING_PLACEMENT_ROOM_TYPE}）`;
}

/** 列表 / 审计里用的短档次名（「三星随机」，不带「待落位」后缀）。识别存量房组文本用。*/
export function randomStarTierShortLabel(tier: number | null | undefined): string {
  if (tier == null) return '';
  return `${STAR_TIER_CN[tier] ?? `${tier}星`}随机`;
}

/** 解析落位名所需的最小订单行形状（真实入参是各调用方 select 出来的行）。*/
export interface PlacementSourceItem {
  hotelRoomType?: {
    name: string;
    hotel: { name: string; randomTierPlaceholder?: number | null };
  } | null;
  randomStarTier?: number | null;
}

/** 房组应写的落位名。*/
export interface RoomGroupPlacement {
  hotelName: string;
  roomType: string;
  /** true = 星级随机档还没落到具体酒店（占位酒店 / 无 FK 的随机行）。*/
  pending: boolean;
  /** 未落位时的档次（占位酒店的 randomTierPlaceholder 或行上的 randomStarTier）；已落位为 null。*/
  pendingTier: number | null;
}

/**
 * 订单行 → 房组应写的酒店名 / 房型名（已落位 / 未落位两态的唯一判定入口）。
 * 两个字段都解析不出来（无 FK、无随机档次）→ null，调用方自行决定不动 / 留空。
 */
export function resolveRoomGroupPlacement(item: PlacementSourceItem): RoomGroupPlacement | null {
  const roomType = item.hotelRoomType ?? null;
  // 联查没带 hotel（只 select 了容量/价格的轻量房型）→ 解析不出酒店名，按「无 FK 信息」处理。
  if (roomType && roomType.hotel) {
    const placeholderTier = roomType.hotel.randomTierPlaceholder ?? null;
    if (placeholderTier != null) {
      return {
        hotelName: randomStarTierLabel(placeholderTier),
        roomType: PENDING_PLACEMENT_ROOM_TYPE,
        pending: true,
        pendingTier: placeholderTier,
      };
    }
    return { hotelName: roomType.hotel.name, roomType: roomType.name, pending: false, pendingTier: null };
  }
  if (item.randomStarTier != null) {
    return {
      hotelName: randomStarTierLabel(item.randomStarTier),
      roomType: PENDING_PLACEMENT_ROOM_TYPE,
      pending: true,
      pendingTier: item.randomStarTier,
    };
  }
  return null;
}

// ── 房组 JSON 的防御式读取 ───────────────────────────────────────────────────

export type RoomGroupRecord = Record<string, unknown>;

/** roomAssignment.roomGroups 数组（形状不符 → null，调用方按「无分房」处理）。*/
export function readRoomGroupArray(roomAssignment: unknown): unknown[] | null {
  if (roomAssignment == null || typeof roomAssignment !== 'object' || Array.isArray(roomAssignment)) {
    return null;
  }
  const groups = (roomAssignment as { roomGroups?: unknown }).roomGroups;
  return Array.isArray(groups) ? groups : null;
}

/** 房组的归属行 id（非空字符串才算归属）。*/
export function roomGroupItemId(group: unknown): string | null {
  if (group == null || typeof group !== 'object') return null;
  const v = (group as { orderItemId?: unknown }).orderItemId;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function readText(group: RoomGroupRecord, key: 'hotelName' | 'roomType' | 'id'): string {
  const v = group[key];
  return typeof v === 'string' ? v : '';
}

/** 一次刷新里被改写的房组（回填留档 / 审计用）。*/
export interface RoomGroupTextChange {
  groupId: string;
  orderItemId: string | null;
  before: { hotelName: string; roomType: string };
  after: { hotelName: string; roomType: string };
}

export interface RefreshRoomGroupsResult {
  changed: boolean;
  /** 改写后的整份 roomAssignment（changed=false 时为原对象，别拿去写库）。*/
  roomAssignment: Record<string, unknown>;
  touched: RoomGroupTextChange[];
}

/**
 * 把 roomAssignment 里属于 `itemId` 的房组改写成 `placement`。
 *
 * 匹配口径（与换酒店流程一脉相承）：
 *   · 优先 `orderItemId === itemId` 精确匹配（split-room-group / 分房保存写入的归属）——
 *     这是数据模型上百分百的「这组人就是这一行的客人」；
 *   · 本行**没有任何**归属组时，才对「无归属」的组用调用方给的 `legacyMatch` 做旧文本匹配
 *     （已归属到其它行的组绝不参与，名字撞上也不改）；不传 legacyMatch = 只认精确归属。
 *
 * 只改 hotelName / roomType 两个字段，其余键（passengerIds / notes / roomFraction / splitPairKey…）
 * 原样保留；文本本就相同的组不计入 touched。
 */
export function refreshRoomGroupsForItem(
  roomAssignment: unknown,
  itemId: string,
  placement: { hotelName: string; roomType: string },
  options: { legacyMatch?: (group: RoomGroupRecord) => boolean } = {},
): RefreshRoomGroupsResult {
  const groups = readRoomGroupArray(roomAssignment);
  const unchanged: RefreshRoomGroupsResult = {
    changed: false,
    roomAssignment: (roomAssignment ?? {}) as Record<string, unknown>,
    touched: [],
  };
  if (!groups) return unchanged;

  const hasOwnAttribution = groups.some((g) => roomGroupItemId(g) === itemId);
  const touched: RoomGroupTextChange[] = [];
  const nextGroups = groups.map((g) => {
    if (g == null || typeof g !== 'object' || Array.isArray(g)) return g;
    const rec = g as RoomGroupRecord;
    const attributedTo = roomGroupItemId(rec);
    const matched = hasOwnAttribution
      ? attributedTo === itemId
      : attributedTo == null && options.legacyMatch != null && options.legacyMatch(rec);
    if (!matched) return g;
    const before = { hotelName: readText(rec, 'hotelName'), roomType: readText(rec, 'roomType') };
    if (before.hotelName === placement.hotelName && before.roomType === placement.roomType) return g;
    touched.push({
      groupId: readText(rec, 'id'),
      orderItemId: attributedTo,
      before,
      after: { hotelName: placement.hotelName, roomType: placement.roomType },
    });
    return { ...rec, hotelName: placement.hotelName, roomType: placement.roomType };
  });
  if (touched.length === 0) return unchanged;
  return {
    changed: true,
    roomAssignment: { ...(roomAssignment as Record<string, unknown>), roomGroups: nextGroups },
    touched,
  };
}

// ── 套餐名前缀的行描述 ───────────────────────────────────────────────────────

/** 套餐派生行（机票腿等）的 description 前缀：「<套餐名> · 」。*/
export function bundleDescriptionPrefix(bundleName: string): string {
  return `${bundleName} · `;
}

/**
 * 「<旧套餐名> · 去程（经济舱）」→「<新套餐名> · 去程（经济舱）」。
 * 只认**精确前缀**（含分隔符「 · 」），不是这个前缀 → null（调用方不动该行）。
 * 旧名为空 / 新旧同名 → null。
 */
export function renameBundlePrefixedDescription(
  description: string,
  fromBundleName: string | null | undefined,
  toBundleName: string,
): string | null {
  if (!fromBundleName || fromBundleName === toBundleName) return null;
  const prefix = bundleDescriptionPrefix(fromBundleName);
  if (!description.startsWith(prefix)) return null;
  return bundleDescriptionPrefix(toBundleName) + description.slice(prefix.length);
}

/**
 * 房组 hotelName 文本「明显是套餐名」的特征：含「N天N晚」。
 * 真实酒店名不会长这样；套餐名（「三星 2天1晚 岘港」）几乎都长这样。
 * 命中 = 这段文本不是房控排出来的酒店，而是早期分房弹窗把套餐行 description 首段当酒店名存下来的残留。
 */
const BUNDLE_LIKE_HOTEL_TEXT_RE = /\d+\s*天\s*\d+\s*晚/;

export function isBundleLikeHotelText(text: string | null | undefined): boolean {
  return typeof text === 'string' && BUNDLE_LIKE_HOTEL_TEXT_RE.test(text);
}

// ── 存量回填的判定内核（scripts/backfill-room-group-hotel-name.ts 只捞数据 / 打印 / 落库）──

/** 回填判定所需的订单行视图（Decimal 等已在脚本层转掉，判定层只见纯值）。*/
export interface BackfillItemView extends PlacementSourceItem {
  id: string;
  kind: string;
  description: string;
  metadata: unknown;
}

export interface BackfillOrderView {
  id: string;
  orderNumber: string;
  roomAssignment: unknown;
  items: BackfillItemView[];
}

export interface BackfillDescriptionChange {
  itemId: string;
  before: string;
  after: string;
}

export interface BackfillPlan {
  /** 改写后的整份 roomAssignment；null = 房组无需改。*/
  roomAssignment: Record<string, unknown> | null;
  groupChanges: RoomGroupTextChange[];
  descriptionChanges: BackfillDescriptionChange[];
  /** 没改的房组及原因（只记「看起来该改却没改」的，静默一致的不记）。*/
  skipped: Array<{ groupId: string; reason: string }>;
}

const BUNDLE_CHANGE_DIFF_RE = /^套餐改档差额：(.+?) → (.+?)（/u;

function readObject(raw: unknown): Record<string, unknown> {
  return raw != null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/**
 * 系统生成的随机档标签文本：「随机四星」（占位酒店命名）/「四星随机」（列表短档次名）/
 * 「四星随机（待落位）」（导出 / 房组文案）。这些从来不是房控手打的酒店名 —— 不论档次是否还对得上
 * （改档 4→3 后房组停在「随机四星」正是要修的场景）。
 */
const RANDOM_TIER_LABEL_TEXT_RE = /^(随机[一二三四五六]星|[一二三四五六]星随机(（待落位）)?)$/u;

export function isRandomTierLabelText(text: string | null | undefined): boolean {
  return typeof text === 'string' && RANDOM_TIER_LABEL_TEXT_RE.test(text.trim());
}

/**
 * 房组当前 hotelName 是否属于「派生残留」—— 只有这四类才允许回填改写：
 *   · 空；
 *   · 套餐名（含「N天N晚」）—— 早期分房弹窗把套餐行 description 首段当酒店名；
 *   · 随机档标签文本（「随机X星」/「X星随机」/「X星随机（待落位）」，见 isRandomTierLabelText）；
 *   · 未落位行上、恰好等于占位酒店字面名的文本（占位酒店被改过名也认得出）。
 * 其它文本一律视为房控手填，回填不碰（导出本来就刻意跟房控走）。
 */
export function isDerivedResidualHotelText(
  hotelName: string,
  item: PlacementSourceItem,
  placement: RoomGroupPlacement,
): boolean {
  const text = hotelName.trim();
  if (text === '') return true;
  if (isBundleLikeHotelText(text)) return true;
  if (isRandomTierLabelText(text)) return true;
  if (placement.pending && item.hotelRoomType?.hotel?.name && text === item.hotelRoomType.hotel.name) {
    return true;
  }
  return false;
}

/** 房控已填的房型文本（非空、非「待落位」、非套餐名）回填时保留。*/
function isManualRoomTypeText(roomType: string): boolean {
  const text = roomType.trim();
  return text !== '' && text !== PENDING_PLACEMENT_ROOM_TYPE && !isBundleLikeHotelText(text);
}

/**
 * 一张单的回填计划（纯函数）：
 *   1. 房组：带 orderItemId → 按归属行落位；无归属但文本是套餐名、且本单**恰好一条**能解析落位的
 *      占房行 → 按那一行（只有一个地方可归属才敢认）；其余无归属组不动。
 *   2. 机票腿等派生行 description：套餐行 metadata.bundleChange 能推出 to 名（且与套餐行现名一致）时，
 *      把「<from 名> · 」前缀（from 名来自 bundleChange.fromBundleName + 历次差额行描述）换成 to 名。
 */
export function planRoomGroupTextBackfill(order: BackfillOrderView): BackfillPlan {
  const groupChanges: RoomGroupTextChange[] = [];
  const skipped: Array<{ groupId: string; reason: string }> = [];
  const itemById = new Map(order.items.map((it) => [it.id, it] as const));
  const placeableItems = order.items
    .map((it) => ({ item: it, placement: resolveRoomGroupPlacement(it) }))
    .filter((x): x is { item: BackfillItemView; placement: RoomGroupPlacement } => x.placement != null);
  const soleTarget = placeableItems.length === 1 ? placeableItems[0] : null;

  const groups = readRoomGroupArray(order.roomAssignment);
  let nextGroups: unknown[] | null = null;
  if (groups) {
    nextGroups = groups.map((g) => {
      if (g == null || typeof g !== 'object' || Array.isArray(g)) return g;
      const rec = g as RoomGroupRecord;
      const groupId = typeof rec.id === 'string' ? rec.id : '';
      const hotelName = typeof rec.hotelName === 'string' ? rec.hotelName : '';
      const roomType = typeof rec.roomType === 'string' ? rec.roomType : '';
      const attributedTo = roomGroupItemId(rec);

      let target: { item: BackfillItemView; placement: RoomGroupPlacement } | null = null;
      if (attributedTo) {
        const item = itemById.get(attributedTo);
        if (!item) {
          skipped.push({ groupId, reason: '归属行不存在于本单，交人工' });
          return g;
        }
        const placement = resolveRoomGroupPlacement(item);
        if (!placement) {
          if (hotelName.trim() === '' || isBundleLikeHotelText(hotelName)) {
            skipped.push({ groupId, reason: '归属行无落位信息（无 FK 无档次），交人工' });
          }
          return g;
        }
        target = { item, placement };
      } else if (isBundleLikeHotelText(hotelName)) {
        if (!soleTarget) {
          skipped.push({ groupId, reason: '房组无行归属且本单占房行不唯一，交人工' });
          return g;
        }
        target = soleTarget;
      } else {
        return g;
      }

      if (hotelName === target.placement.hotelName) return g;
      if (!isDerivedResidualHotelText(hotelName, target.item, target.placement)) {
        skipped.push({ groupId, reason: `房控手填「${hotelName}」与行落位「${target.placement.hotelName}」不同，交人工` });
        return g;
      }
      const nextRoomType = isManualRoomTypeText(roomType) ? roomType : target.placement.roomType;
      groupChanges.push({
        groupId,
        orderItemId: attributedTo ?? target.item.id,
        before: { hotelName, roomType },
        after: { hotelName: target.placement.hotelName, roomType: nextRoomType },
      });
      return { ...rec, hotelName: target.placement.hotelName, roomType: nextRoomType };
    });
  }

  // 机票腿等派生行的套餐名前缀
  const descriptionChanges: BackfillDescriptionChange[] = [];
  const bundleRow = order.items.find((it) => it.kind === 'BUNDLE');
  const bundleChange = bundleRow ? readObject(readObject(bundleRow.metadata).bundleChange) : {};
  const toName = typeof bundleChange.toBundleName === 'string' ? bundleChange.toBundleName : null;
  if (bundleRow && toName && bundleRow.description === toName) {
    const fromNames = new Set<string>();
    if (typeof bundleChange.fromBundleName === 'string') fromNames.add(bundleChange.fromBundleName);
    for (const it of order.items) {
      if (readObject(it.metadata).bundleChange !== true) continue;
      const m = BUNDLE_CHANGE_DIFF_RE.exec(it.description);
      if (m) {
        fromNames.add(m[1]);
        fromNames.add(m[2]);
      }
    }
    fromNames.delete(toName);
    for (const it of order.items) {
      if (it.id === bundleRow.id) continue;
      for (const fromName of fromNames) {
        const renamed = renameBundlePrefixedDescription(it.description, fromName, toName);
        if (renamed == null) continue;
        descriptionChanges.push({ itemId: it.id, before: it.description, after: renamed });
        break;
      }
    }
  }

  return {
    roomAssignment:
      groupChanges.length > 0 && nextGroups
        ? { ...(order.roomAssignment as Record<string, unknown>), roomGroups: nextGroups }
        : null,
    groupChanges,
    descriptionChanges,
    skipped,
  };
}
