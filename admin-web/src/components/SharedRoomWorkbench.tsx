/**
 * 跨单分房工作台（§十二）——房控页入口，把「两张单合住一间房」的编辑收口到这里。
 *
 * 心智与 RoomingEditor 一致（左池右盒子拖拽），区别是池子横跨多张订单：
 *   - 左侧 = 本酒店本入住区间内全部有效订单的出行人，按订单分组显示。
 *   - 右侧 = 共享房盒子，每盒的成员再按来源订单分组（每单一档可改份额）。
 *   - 一次「保存」把整批改动提交给 PUT /hotel-control/shared-rooms（服务端 Σ份额=1 硬校验、
 *     expectedVersions 版本 CAS、requestToken 幂等）。
 *
 * 真值优先级：本组件只是编辑态草稿，保存成功后一律重新拉取工作台落地为准——不在本地
 * 「乐观」拼版本号；切酒店/入住/退房会重新加载工作台，未保存的草稿随之丢弃（与 RoomingEditor
 * 「关了就丢」同一纪律，本组件另加了切换提示）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  ApiError,
  hotelControlOpsApi,
  type Hotel,
  type OrderStatus,
  type SaveSharedRoomsBody,
  type SharedRoomWorkbench as SharedRoomWorkbenchData,
  type SharedRoomWorkbenchOrder,
  type SharedRoomWorkbenchPassenger,
  type SharedRoomWorkbenchRoomMember,
} from '../lib/api';
import { Icon } from './Icon';
import { useDialogA11y } from './Modal';
import { orderStatusBadgeClass, orderStatusLabel } from '../lib/orderStatus';
import { passengerDisplayName, passengerNameTitle } from '../lib/passengerDisplayName';

const HALF_STEP = 0.5;

// ── 工具 ─────────────────────────────────────────────────────────────────
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `srw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function plusDaysStr(base: string, n: number): string {
  const d = new Date(`${base}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** 份额 0.5 网格四舍五入，消除浮点尾数——与后端 roundFraction 同口径。 */
function roundHalf(n: number): number {
  return Math.round(n * 2) / 2;
}
function clampFraction(n: number): number {
  return Math.min(20, Math.max(0, n));
}
function genderBadge(gender?: string | null): string | null {
  if (!gender) return null;
  const g = gender.trim().toUpperCase();
  if (g === 'M' || g === '男' || g === 'MALE') return '男';
  if (g === 'F' || g === '女' || g === 'FEMALE') return '女';
  return null;
}
function copyText(text: string): void {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text);
  }
}

/**
 * 房控有效订单状态（B6）——镜像后端 hotel-control.service.ts 的 COUNTED_STATUSES：退款
 * 申请中及以后的订单已释放占房，不计入分房。工作台读模型的订单池本就只含这些状态的订单
 * （getSharedRoomWorkbench 的 items 查询同一个 where），这里复刻一份仅用于兜底判定成员
 * 有效性（见 memberIsActive），不是引入新口径。
 */
const HOTEL_COUNTED_STATUSES: OrderStatus[] = [
  'PENDING_PAYMENT',
  'PAID',
  'PROCESSING',
  'TICKETED',
  'COMPLETED',
  'CHANGE_REQUESTED',
  'CHANGED',
];

/**
 * 判断某位共享房成员当前是否仍处于有效状态订单（B6 对接点）。优先信后端给的 isActive /
 * orderStatus 字段；还没落地时（当前后端）按「所属订单是否出现在本次工作台的有效订单池」
 * 兜底——订单池本就只含 COUNTED_STATUSES，不在池子里 = 订单已失效（取消/退款/软删等），
 * 不能「查不到就当有效」（那样等于放行已失效成员一起提交）。
 */
function memberIsActive(
  m: Pick<SharedRoomWorkbenchRoomMember, 'orderId' | 'isActive' | 'orderStatus'>,
  validOrderIds: ReadonlySet<string>,
): boolean {
  if (typeof m.isActive === 'boolean') return m.isActive;
  if (m.orderStatus) return HOTEL_COUNTED_STATUSES.includes(m.orderStatus);
  return validOrderIds.has(m.orderId);
}

/** 共享房成员列表 → 按「来源订单 + 订单行」重新分组（seedDraftRooms 与「原始态」对比复用）。 */
function groupsFromMembers(members: SharedRoomWorkbenchRoomMember[]): DraftGroup[] {
  const byKey = new Map<string, DraftGroup>();
  for (const m of members) {
    const key = `${m.orderId}:${m.orderItemId}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.passengerIds.push(m.passengerId);
    } else {
      byKey.set(key, {
        orderId: m.orderId,
        orderItemId: m.orderItemId,
        orderNumber: '',
        passengerIds: [m.passengerId],
        roomFraction: m.roomFraction,
      });
    }
  }
  return [...byKey.values()];
}

/** 规范化序列化一组 DraftGroup，用于「本次改动前后是否相同」的字符串比较（顺序无关）。 */
function serializeGroups(groups: DraftGroup[]): string {
  return JSON.stringify(
    groups
      .map((g) => ({
        orderId: g.orderId,
        orderItemId: g.orderItemId,
        roomFraction: g.roomFraction,
        passengerIds: [...g.passengerIds].sort(),
      }))
      .sort((a, b) => `${a.orderId}:${a.orderItemId}`.localeCompare(`${b.orderId}:${b.orderItemId}`)),
  );
}

// ── 草稿态类型（编辑期内存态，保存时按后端形状收敛）──────────────────────────
interface DraftGroup {
  orderId: string;
  orderItemId: string;
  orderNumber: string;
  passengerIds: string[];
  roomFraction: number;
}
interface DraftRoom {
  /** 本地稳定 key：既有共享房 = sharedRoomId 本身；新建房间 = 本地生成的临时 id。 */
  draftId: string;
  /** null = 新建（保存时服务端生成 id）。 */
  sharedRoomId: string | null;
  /** 既有共享房的已知版本（CAS 用）；新建房间为 null。 */
  version: number | null;
  hotelRoomTypeId: string;
  notes: string;
  groups: DraftGroup[];
}

/** 把工作台读模型的既有共享房，摊开成编辑期草稿（成员按「来源订单+订单行」重新分组）。 */
function seedDraftRooms(data: SharedRoomWorkbenchData): DraftRoom[] {
  const orderNumberById = new Map(data.orders.map((o) => [o.orderId, o.orderNumber]));
  return data.sharedRooms.map((r) => ({
    draftId: r.sharedRoomId,
    sharedRoomId: r.sharedRoomId,
    version: r.version,
    hotelRoomTypeId: r.hotelRoomTypeId,
    notes: r.notes ?? '',
    // groupsFromMembers 不知道订单号（只按 members 的 orderId/orderItemId 分组），这里补上
    // 展示用的 orderNumber——不参与保存 payload，也不参与 B2/B6 的「原始态」diff 比较。
    groups: groupsFromMembers(r.members).map((g) => ({
      ...g,
      orderNumber: orderNumberById.get(g.orderId) ?? g.orderId,
    })),
  }));
}

export interface SharedRoomWorkbenchSeed {
  hotelId?: string;
  /** YYYY-MM-DD */
  checkIn?: string;
  /** YYYY-MM-DD */
  checkOut?: string;
}

interface SharedRoomWorkbenchProps {
  token: string;
  /** 默认酒店/入住/退房——通常从销控板当前选中的酒店和日期带入；缺省当日起 1 晚。 */
  seed?: SharedRoomWorkbenchSeed;
  onClose: () => void;
  /** 保存成功后通知父级（房控页据此重拉销控板）。 */
  onSaved?: () => void;
}

// ── 一枚出行人 chip（池子里）── locked：房组归属不完整，不可拖 ──────────────
function PoolPassengerChip({
  p,
  locked,
}: {
  p: SharedRoomWorkbenchPassenger;
  locked: boolean;
}) {
  const g = genderBadge(p.gender);
  const display = passengerDisplayName(p.fullName, p.chineseName);
  const latin = passengerNameTitle(p.fullName, p.chineseName);
  if (locked) {
    return (
      <span
        className="inline-flex select-none items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700"
        title="房组归属不完整，请先在分房编辑器补归属后再拖入共享房"
      >
        {display || '—'}
      </span>
    );
  }
  return (
    <span
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', p.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      className="inline-flex cursor-grab select-none items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs text-ink shadow-sm transition hover:border-brand/40 hover:bg-brand-50 active:cursor-grabbing"
      title={latin ? `${latin} · 拖到右侧房间` : '拖到右侧房间'}
    >
      <span className="font-medium">{display || '—'}</span>
      {g && <span className={g === '男' ? 'text-brand-700' : 'text-rose-600'}>{g}</span>}
    </span>
  );
}

// ── 组件 ─────────────────────────────────────────────────────────────────
export function SharedRoomWorkbench({ token, seed, onClose, onSaved }: SharedRoomWorkbenchProps) {
  const dialogRef = useDialogA11y(onClose);

  // 酒店清单（供选酒店下拉 + 各房型容量）——占位酒店不参与跨单分房（服务端同口径）。
  const [hotels, setHotels] = useState<Hotel[]>([]);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .listHotels(true, token)
      .then((r) => {
        if (!cancelled) setHotels(r.hotels.filter((h) => h.randomTierPlaceholder == null));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [token]);

  const [hotelId, setHotelId] = useState<string>(seed?.hotelId ?? '');
  const [checkIn, setCheckIn] = useState<string>(seed?.checkIn ?? todayStr());
  const [checkOut, setCheckOut] = useState<string>(seed?.checkOut ?? plusDaysStr(checkIn, 1));

  // 酒店清单到货后，若还没选酒店，用 seed 命中的那家或第一家兜底。
  useEffect(() => {
    if (hotelId || hotels.length === 0) return;
    const fromSeed = seed?.hotelId && hotels.some((h) => h.id === seed.hotelId) ? seed.hotelId : null;
    setHotelId(fromSeed ?? hotels[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotels]);

  const roomTypeOptions = useMemo(
    () => hotels.find((h) => h.id === hotelId)?.roomTypes ?? [],
    [hotels, hotelId],
  );

  const [wb, setWb] = useState<SharedRoomWorkbenchData | null>(null);
  const [rooms, setRooms] = useState<DraftRoom[]>([]);
  const [dissolvedVersions, setDissolvedVersions] = useState<Map<string, number>>(new Map());
  const [orderItemChoice, setOrderItemChoice] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);

  const canQuery = Boolean(hotelId && checkIn && checkOut && checkIn < checkOut);

  // 注意：load 本身不清 saveErr/saveOk——保存成功后 handleSave 会调 load() 重拉落地状态，
  // 若这里顺手清掉 saveOk，刚设好的「已保存」提示会在同一拍被冲掉，用户永远看不到。
  // 清空交给下面「查询范围变化」的 effect 和手动「刷新」按钮各自负责。
  const load = useCallback(() => {
    if (!token || !canQuery) return;
    setLoading(true);
    setLoadErr(null);
    hotelControlOpsApi
      .getSharedRoomWorkbench(token, { hotelId, checkIn, checkOut })
      .then((data) => {
        setWb(data);
        setRooms(seedDraftRooms(data));
        setDissolvedVersions(new Map());
        setOrderItemChoice({});
      })
      .catch((e: unknown) => {
        setWb(null);
        setRooms([]);
        setLoadErr(e instanceof ApiError ? e.message : '工作台加载失败');
      })
      .finally(() => setLoading(false));
  }, [token, hotelId, checkIn, checkOut, canQuery]);

  // 查询范围（酒店/入住/退房）变化才清掉旧的保存提示——load() 被 handleSave 复用时不清。
  useEffect(() => {
    setSaveErr(null);
    setSaveOk(null);
    load();
  }, [load]);

  /** 手动点「刷新」（含 409 冲突提示里那个）：顺手清掉旧的保存提示，再重拉。 */
  function handleManualRefresh(): void {
    setSaveErr(null);
    setSaveOk(null);
    load();
  }

  // ── 索引：乘客 → 所属订单；订单 id → 订单 ────────────────────────────────
  const orderById = useMemo(() => {
    const m = new Map<string, SharedRoomWorkbenchOrder>();
    for (const o of wb?.orders ?? []) m.set(o.orderId, o);
    return m;
  }, [wb]);
  const passengerIndex = useMemo(() => {
    const m = new Map<string, { orderId: string; orderNumber: string; passenger: SharedRoomWorkbenchPassenger }>();
    for (const o of wb?.orders ?? []) {
      for (const p of o.passengers) m.set(p.id, { orderId: o.orderId, orderNumber: o.orderNumber, passenger: p });
    }
    return m;
  }, [wb]);
  const assignedIds = useMemo(() => {
    const s = new Set<string>();
    for (const r of rooms) for (const g of r.groups) for (const pid of g.passengerIds) s.add(pid);
    return s;
  }, [rooms]);

  // ── 已失效成员（B6）：既有共享房里成员所属订单已取消/退款/软删等——订单不在本次工作台
  // 有效订单池（wb.orders）里，性别（passengerIndex 只索引有效池里的乘客）查不到；姓名/
  // 单号/状态服务端直接给（见 SharedRoomWorkbenchRoomMember：name/chineseName/orderNumber/
  // orderStatus），不必绕回订单池。只在既有共享房（wb.sharedRooms）里找，新建房间的成员
  // 必然来自当前有效池。
  const invalidPassengerIds = useMemo(() => {
    const validOrderIds = new Set((wb?.orders ?? []).map((o) => o.orderId));
    const s = new Set<string>();
    for (const r of wb?.sharedRooms ?? []) {
      for (const m of r.members) {
        if (!memberIsActive(m, validOrderIds)) s.add(m.passengerId);
      }
    }
    return s;
  }, [wb]);
  const invalidMemberInfo = useMemo(() => {
    const m = new Map<
      string,
      { orderId: string; orderStatus: OrderStatus; orderNumber: string; chineseName: string | null; name: string }
    >();
    for (const r of wb?.sharedRooms ?? []) {
      for (const mem of r.members) {
        if (invalidPassengerIds.has(mem.passengerId)) {
          m.set(mem.passengerId, {
            orderId: mem.orderId,
            orderStatus: mem.orderStatus,
            orderNumber: mem.orderNumber,
            chineseName: mem.chineseName,
            name: mem.name,
          });
        }
      }
    }
    return m;
  }, [wb, invalidPassengerIds]);

  function resolveOrderItemId(orderId: string): string | null {
    const order = orderById.get(orderId);
    if (!order || order.items.length === 0) return null;
    if (order.items.length === 1) return order.items[0].id;
    return orderItemChoice[orderId] ?? order.items[0].id;
  }

  // ── 移动出行人：池 ↔ 盒子、盒子 ↔ 盒子；归属不完整的单一律拒绝拖入共享房 ──
  function movePassengerToRoom(passengerId: string, targetDraftId: string | null): void {
    const loc = passengerIndex.get(passengerId);
    if (!loc) return;
    const order = orderById.get(loc.orderId);
    if (!order) return;
    if (targetDraftId != null && !order.fullyAttributed) return;
    const orderItemId = targetDraftId != null ? resolveOrderItemId(loc.orderId) : null;
    if (targetDraftId != null && !orderItemId) return;

    setRooms((prev) => {
      let next = prev.map((r) => ({
        ...r,
        groups: r.groups
          .map((g) => ({ ...g, passengerIds: g.passengerIds.filter((id) => id !== passengerId) }))
          .filter((g) => g.passengerIds.length > 0),
      }));
      if (targetDraftId == null) return next;
      next = next.map((r) => {
        if (r.draftId !== targetDraftId) return r;
        const idx = r.groups.findIndex((g) => g.orderId === loc.orderId && g.orderItemId === orderItemId);
        if (idx >= 0) {
          if (r.groups[idx].passengerIds.includes(passengerId)) return r;
          const groups = [...r.groups];
          groups[idx] = { ...groups[idx], passengerIds: [...groups[idx].passengerIds, passengerId] };
          return { ...r, groups };
        }
        // 拍板默认份额：一间房里第一张单 1、其余 0（房控可手改）。
        const fraction = r.groups.length === 0 ? 1 : 0;
        return {
          ...r,
          groups: [
            ...r.groups,
            {
              orderId: loc.orderId,
              orderItemId: orderItemId as string,
              orderNumber: loc.orderNumber,
              passengerIds: [passengerId],
              roomFraction: fraction,
            },
          ],
        };
      });
      return next;
    });
  }

  const [dragId, setDragId] = useState<string | null>(null);
  function handleDropToRoom(draftId: string, e: React.DragEvent): void {
    e.preventDefault();
    const pid = e.dataTransfer.getData('text/plain') || dragId;
    if (pid) movePassengerToRoom(pid, draftId);
    setDragId(null);
  }
  function handleDropToPool(e: React.DragEvent): void {
    e.preventDefault();
    const pid = e.dataTransfer.getData('text/plain') || dragId;
    if (pid) movePassengerToRoom(pid, null);
    setDragId(null);
  }

  // ── 房间盒子增删（新建可直接删；既有共享房用「解散」）──────────────────────
  function addRoom(): void {
    setRooms((prev) => [
      ...prev,
      { draftId: newId(), sharedRoomId: null, version: null, hotelRoomTypeId: roomTypeOptions[0]?.id ?? '', notes: '', groups: [] },
    ]);
  }
  function removeNewRoom(draftId: string): void {
    setRooms((prev) => prev.filter((r) => !(r.draftId === draftId && r.sharedRoomId == null)));
  }
  function dissolveRoom(draftId: string): void {
    const room = rooms.find((r) => r.draftId === draftId);
    if (!room || room.sharedRoomId == null) return;
    setDissolvedVersions((dv) => new Map(dv).set(room.sharedRoomId as string, room.version ?? 0));
    setRooms((prev) => prev.filter((r) => r.draftId !== draftId));
  }
  function patchRoom(draftId: string, patch: Partial<Pick<DraftRoom, 'hotelRoomTypeId' | 'notes'>>): void {
    setRooms((prev) => prev.map((r) => (r.draftId === draftId ? { ...r, ...patch } : r)));
  }
  function stepFraction(draftId: string, orderId: string, orderItemId: string, delta: number): void {
    setRooms((prev) =>
      prev.map((r) =>
        r.draftId !== draftId
          ? r
          : {
              ...r,
              groups: r.groups.map((g) =>
                g.orderId === orderId && g.orderItemId === orderItemId
                  ? { ...g, roomFraction: clampFraction(roundHalf(g.roomFraction + delta)) }
                  : g,
              ),
            },
      ),
    );
  }

  /**
   * 房间统计——按 r.groups 全量（含失效成员）算 Σ份额/人数/异性混拼/超容量（N5）：失效
   * 成员在没有被显式移除前，本就会原样回传参与保存，这套数字必须和保存时实际提交的内容
   * 一致，不能只按「净成员」算——否则前端会在 Σ 应为 1 的地方看见一个和后端口径对不上
   * 的数字，甚至拦下一次后端本会放行的保存（见 handleSave 同款口径）。invalidPax 单独
   * 算出来只用于下面渲染「含 N 名已失效成员」提示，不再从 Σ/人数里剔除。
   */
  function roomStats(r: DraftRoom) {
    const roomType = roomTypeOptions.find((rt) => rt.id === r.hotelRoomTypeId);
    const totalFraction = roundHalf(r.groups.reduce((s, g) => s + g.roomFraction, 0));
    const totalPax = r.groups.reduce((s, g) => s + g.passengerIds.length, 0);
    const invalidPax = r.groups.reduce(
      (s, g) => s + g.passengerIds.filter((id) => invalidPassengerIds.has(id)).length,
      0,
    );
    const genders = new Set<string>();
    for (const g of r.groups) {
      for (const pid of g.passengerIds) {
        const gd = passengerIndex.get(pid)?.passenger.gender;
        if (gd === 'M' || gd === 'F') genders.add(gd);
      }
    }
    return {
      roomType,
      totalFraction,
      totalPax,
      invalidPax,
      mixedGender: genders.size > 1,
      overCapacity: !!roomType && roomType.capacity > 0 && totalPax > roomType.capacity,
    };
  }

  /** 显式「移除失效成员」（N5）：只有点了这个按钮，失效成员才真正从本间房剔除——否则
   *  一律原样回传，不因为「只改了备注/别的成员」而被悄悄带走。群组被移空则整组丢弃。 */
  function removeInvalidMember(draftId: string, orderId: string, orderItemId: string, passengerId: string): void {
    setRooms((prev) =>
      prev.map((r) =>
        r.draftId !== draftId
          ? r
          : {
              ...r,
              groups: r.groups
                .map((g) =>
                  g.orderId === orderId && g.orderItemId === orderItemId
                    ? { ...g, passengerIds: g.passengerIds.filter((id) => id !== passengerId) }
                    : g,
                )
                .filter((g) => g.passengerIds.length > 0),
            },
      ),
    );
  }

  // ── 保存 ───────────────────────────────────────────────────────────────
  async function handleSave(): Promise<void> {
    if (!wb) return;
    setSaveErr(null);
    setSaveOk(null);

    // 既有共享房：与「本次加载时的落库成员」原样对比（N5：不再先剔除失效成员再比较）——
    // 没变化（房型/备注也没改）就不重新提交，避免把「历史上就含失效成员、本次根本没碰过」
    // 的房间也扫进 payload。失效成员在没被 removeInvalidMember 显式移除前，作为普通成员
    // 参与这次比较和提交——服务端「提交集合即最终集合」，前端不能借着展示层的「失效」判定
    // 悄悄把人从提交集合里拿掉，那等于替运营做了一次没人点过的删除。真正清空的（拖空 /
    // 全部迁出 / 显式移除到空）且确实动过 → 视同解散，折进 dissolve（B2：「全部拖回池也算
    // 变更」）。新建房间没有「原始态」可比，有成员就直接提交，没有就跳过（用户建了空房又
    // 没填人，等同没建；新建房只能来自乘客池拖拽，池子本就不含失效成员，无需过滤）。
    const dissolveMap = new Map(dissolvedVersions);
    const roomsToSave: Array<{ room: DraftRoom; groups: DraftGroup[] }> = [];
    for (const r of rooms) {
      if (!r.sharedRoomId) {
        if (r.groups.length > 0) roomsToSave.push({ room: r, groups: r.groups });
        continue;
      }
      if (dissolveMap.has(r.sharedRoomId)) continue; // 已被「解散整间」按钮显式标记

      const seedRoom = wb.sharedRooms.find((sr) => sr.sharedRoomId === r.sharedRoomId);
      const originalGroups = seedRoom ? groupsFromMembers(seedRoom.members) : [];
      const metaChanged = seedRoom
        ? seedRoom.hotelRoomTypeId !== r.hotelRoomTypeId || (seedRoom.notes ?? '') !== r.notes.trim()
        : true;
      const membersChanged = serializeGroups(originalGroups) !== serializeGroups(r.groups);
      // L2：正常代码路径不会留下零成员的 ACTIVE 共享房（后端解散时自动 DISSOLVED），只有
      // 直接改库才会造出这种脏数据——但一旦出现，「本次没碰过就不重提交」这条闸会连它一起
      // 挡住：原始态与本次都是空成员，metaChanged/membersChanged 双 false，永远进不到下面
      // 的折叠解散分支，运营点「保存」也救不了它，只能再点一次显式的「解散整间」按钮才行。
      // 零成员房不受这条「未改动」豁免——不管碰没碰过，都该走到下面折叠成 dissolve。
      if (!metaChanged && !membersChanged && r.groups.length > 0) continue; // 本次没碰过（含失效成员在内）且非空，不重提交

      if (r.groups.length === 0) {
        dissolveMap.set(r.sharedRoomId, r.version ?? 0);
        continue;
      }
      roomsToSave.push({ room: r, groups: r.groups });
    }

    for (const { room, groups } of roomsToSave) {
      if (!room.hotelRoomTypeId) {
        setSaveErr('每间房都要先选房型再保存');
        return;
      }
      // Σ 按提交集合全量算（含未显式移除的失效成员），与后端 Σ份额=1 硬校验同一把尺
      // （N5）——不能只按「活跃成员」算，否则会在后端本会放行的地方被前端自己拦下。
      const totalFraction = roundHalf(groups.reduce((s, g) => s + g.roomFraction, 0));
      if (totalFraction !== 1) {
        const roomType = roomTypeOptions.find((rt) => rt.id === room.hotelRoomTypeId);
        setSaveErr(
          `房间「${roomType?.name ?? room.hotelRoomTypeId}」的计费份额合计须为 1，当前为 ${totalFraction}`,
        );
        return;
      }
    }
    if (roomsToSave.length === 0 && dissolveMap.size === 0) {
      setSaveErr('还没有任何改动');
      return;
    }

    const expectedVersions: Record<string, number> = {};
    for (const { room } of roomsToSave) if (room.sharedRoomId) expectedVersions[room.sharedRoomId] = room.version ?? 0;
    for (const [id, v] of dissolveMap) expectedVersions[id] = v;

    const body: SaveSharedRoomsBody = {
      hotelId: wb.hotelId,
      checkIn: wb.checkIn,
      checkOut: wb.checkOut,
      requestToken: newId(),
      expectedVersions,
      rooms: roomsToSave.map(({ room, groups }) => ({
        ...(room.sharedRoomId ? { sharedRoomId: room.sharedRoomId } : {}),
        hotelRoomTypeId: room.hotelRoomTypeId,
        ...(room.notes.trim() ? { notes: room.notes.trim() } : {}),
        groups: groups.map((g) => ({
          orderId: g.orderId,
          orderItemId: g.orderItemId,
          passengerIds: g.passengerIds,
          roomFraction: g.roomFraction,
        })),
      })),
      dissolve: [...dissolveMap.keys()],
    };

    setSaving(true);
    try {
      const result = await hotelControlOpsApi.saveSharedRooms(token, body);
      setSaveOk(
        `已保存 · ${result.rooms.length} 间房${result.dissolved.length ? ` · 解散 ${result.dissolved.length} 间` : ''}` +
          (result.warnings.length ? ` · ${result.warnings.join('；')}` : ''),
      );
      onSaved?.();
      load(); // 重拉落地状态（新版本号），继续编辑
    } catch (e: unknown) {
      // 400/409 文案后端已给好，直接展示；409 提示刷新（下方按钮已在，不额外弹窗）。
      setSaveErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  const isConflict = saveErr != null && saveErr.includes('已被他人修改');
  const poolOrders = wb?.orders ?? [];

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="跨单分房工作台"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 头部：标题 + 关闭 ── */}
        <div className="flex items-start justify-between gap-2 border-b border-slate-200 px-5 py-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-base font-semibold text-ink">
              <Icon name="users" /> 跨单分房工作台
            </h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              把不同订单的出行人拖进同一间房，一次保存写成真值（房控物理房、导出房号都按它算）。
            </p>
          </div>
          <button type="button" className="text-slate-400 hover:text-slate-700" onClick={onClose} aria-label="关闭跨单分房工作台">
            <Icon name="close" />
          </button>
        </div>

        {/* ── 查询条件：酒店 + 入住 + 退房 ── */}
        <div className="flex flex-wrap items-end gap-2 border-b border-slate-200 bg-slate-50/60 px-5 py-3">
          <div>
            <label className="label">酒店</label>
            <select className="input sm:w-56" value={hotelId} onChange={(e) => setHotelId(e.target.value)}>
              {hotels.length === 0 && <option value="">加载中…</option>}
              {hotels.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">入住</label>
            <input type="date" className="input" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
          </div>
          <div>
            <label className="label">退房</label>
            <input type="date" className="input" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
          </div>
          <button type="button" className="btn-secondary" onClick={handleManualRefresh} disabled={loading || !canQuery}>
            <Icon name="refresh" /> {loading ? '加载中…' : '刷新'}
          </button>
          {!canQuery && <span className="text-xs text-amber-700">入住日须早于退房日</span>}
          <span className="ml-auto text-xs text-ink-muted">切酒店/日期会丢弃当前未保存的改动</span>
        </div>

        {/* ── 主体：左池右盒子 ── */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loadErr && <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{loadErr}</div>}
          {loading && !wb && <div className="py-8 text-center text-sm text-ink-muted">加载中…</div>}
          {!loading && wb && poolOrders.length === 0 && rooms.length === 0 && (
            <div className="py-10 text-center text-sm text-ink-muted">
              该酒店该入住区间暂无有效订单，也没有既有共享房。
            </div>
          )}

          {wb && (poolOrders.length > 0 || rooms.length > 0) && (
            <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
              {/* ── 左：跨订单乘客池（按订单分组）── */}
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDropToPool}
                className="space-y-2 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-3"
              >
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">跨订单乘客池</span>
                  <span className="badge-neutral">{poolOrders.length} 单</span>
                </div>
                {poolOrders.length === 0 ? (
                  <div className="py-6 text-center text-xs text-ink-muted">本区间没有可分房的订单</div>
                ) : (
                  poolOrders.map((order) => {
                    const remaining = order.passengers.filter((p) => !assignedIds.has(p.id));
                    return (
                      <div key={order.orderId} className="rounded-lg border border-slate-200 bg-white p-2">
                        <div className="mb-1 flex flex-wrap items-center justify-between gap-1">
                          <span className="font-mono text-xs text-ink">{order.orderNumber}</span>
                          <span className={orderStatusBadgeClass(order.status)}>{orderStatusLabel(order.status)}</span>
                        </div>
                        {!order.fullyAttributed && (
                          <div className="mb-1 rounded bg-amber-50 px-2 py-1 text-[11px] leading-relaxed text-amber-700">
                            房组归属不完整，请先在分房编辑器给全部房组补齐归属订单行，才能拉进共享房。
                            <button
                              type="button"
                              className="ml-1 underline"
                              onClick={() => copyText(order.orderNumber)}
                            >
                              复制单号
                            </button>
                            <Link to="/orders" className="ml-1 underline">
                              去订单页 →
                            </Link>
                          </div>
                        )}
                        {order.items.length > 1 && (
                          <select
                            className="input mb-1 w-full py-1 text-xs"
                            value={orderItemChoice[order.orderId] ?? order.items[0]?.id ?? ''}
                            onChange={(e) =>
                              setOrderItemChoice((prev) => ({ ...prev, [order.orderId]: e.target.value }))
                            }
                            title="本单在本酒店有多条酒店行：选一条，接下来拖的人都计入这条行"
                          >
                            {order.items.map((it) => (
                              <option key={it.id} value={it.id}>
                                计入：{it.roomTypeName || it.hotelRoomTypeId}
                              </option>
                            ))}
                          </select>
                        )}
                        {remaining.length === 0 ? (
                          <div className="py-1 text-center text-[11px] text-ink-muted">已全部分入房间</div>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {remaining.map((p) => (
                              <PoolPassengerChip key={p.id} p={p} locked={!order.fullyAttributed} />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* ── 右：共享房盒子 ── */}
              <div className="space-y-3">
                {rooms.map((r) => {
                  const stats = roomStats(r);
                  // Σ 按全量成员算（含未显式移除的失效成员，N5），与提交口径一致；
                  // 房间彻底没有任何成员（含失效）时不报，那种情况保存时会折成解散。
                  const fractionBad = r.groups.length > 0 && stats.totalFraction !== 1;
                  return (
                    <div
                      key={r.draftId}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => handleDropToRoom(r.draftId, e)}
                      className="rounded-xl border border-slate-200 bg-surface p-3 shadow-sm transition hover:border-brand/30"
                    >
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                          <Icon name="hotel" />
                          {r.sharedRoomId ? (
                            <span className="badge bg-indigo-100 text-indigo-700" title={`已保存 · 版本 ${r.version}`}>
                              已保存
                            </span>
                          ) : (
                            <span className="badge-neutral">新建</span>
                          )}
                          <span className="text-xs font-normal text-ink-muted">{stats.totalPax} 人</span>
                          <span
                            className={`text-xs font-normal ${fractionBad ? 'font-semibold text-rose-700' : 'text-ink-muted'}`}
                          >
                            Σ份额 {stats.totalFraction}{fractionBad ? '（应为 1）' : ''}
                          </span>
                          {stats.mixedGender && (
                            <span className="badge-warning" title="异性混拼：夫妻/家庭属正常，其他情况请确认">
                              混性别
                            </span>
                          )}
                          {stats.overCapacity && (
                            <span className="badge-warning" title="人数超房型容量，仅提示不拦截">
                              超容量
                            </span>
                          )}
                          {stats.invalidPax > 0 && (
                            <span
                              className="badge bg-slate-100 text-ink-muted"
                              title="该成员所属订单已不是有效状态（取消/退款/软删等）——保存时原样保留计费，不会自动剔除；如需真正移除，点灰色 chip 上的 ×"
                            >
                              含 {stats.invalidPax} 名已失效成员
                            </span>
                          )}
                        </span>
                        {r.sharedRoomId ? (
                          <button type="button" className="btn-ghost-danger px-2 py-1 text-xs" onClick={() => dissolveRoom(r.draftId)}>
                            解散整间
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn-ghost-danger px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40"
                            onClick={() => removeNewRoom(r.draftId)}
                            disabled={r.groups.length > 0}
                            title={r.groups.length > 0 ? '先把人移出去再删' : '删除空房间'}
                          >
                            删除
                          </button>
                        )}
                      </div>

                      <select
                        className="input w-full py-1.5 text-sm"
                        value={r.hotelRoomTypeId}
                        onChange={(e) => patchRoom(r.draftId, { hotelRoomTypeId: e.target.value })}
                      >
                        <option value="">选房型</option>
                        {roomTypeOptions.map((rt) => (
                          <option key={rt.id} value={rt.id}>
                            {rt.name}
                            {rt.capacity > 0 ? `（限 ${rt.capacity} 人）` : ''}
                          </option>
                        ))}
                      </select>

                      {/* 成员按来源单分组 */}
                      <div className="mt-2 min-h-[2.5rem] space-y-1.5 rounded-lg border border-dashed border-slate-200 bg-slate-50/50 p-2">
                        {r.groups.length === 0 ? (
                          <div className="py-1 text-center text-xs text-ink-muted">把左侧出行人拖到这里</div>
                        ) : (
                          r.groups.map((g) => (
                            <div key={`${g.orderId}:${g.orderItemId}`} className="rounded-md bg-white p-1.5 shadow-sm">
                              <div className="mb-1 flex flex-wrap items-center justify-between gap-1">
                                <span className="font-mono text-[11px] text-ink-soft">{g.orderNumber}</span>
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    className="rounded border border-slate-200 px-1.5 text-xs text-ink-soft hover:bg-slate-50"
                                    onClick={() => stepFraction(r.draftId, g.orderId, g.orderItemId, -HALF_STEP)}
                                  >
                                    −
                                  </button>
                                  <span className="w-8 text-center text-xs font-medium text-ink">{g.roomFraction}</span>
                                  <button
                                    type="button"
                                    className="rounded border border-slate-200 px-1.5 text-xs text-ink-soft hover:bg-slate-50"
                                    onClick={() => stepFraction(r.draftId, g.orderId, g.orderItemId, HALF_STEP)}
                                  >
                                    ＋
                                  </button>
                                </div>
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {g.passengerIds.map((pid) => {
                                  const p = passengerIndex.get(pid)?.passenger;
                                  if (p) {
                                    const display = passengerDisplayName(p.fullName, p.chineseName);
                                    return (
                                      <span
                                        key={pid}
                                        draggable
                                        onDragStart={(e) => {
                                          e.dataTransfer.setData('text/plain', pid);
                                          e.dataTransfer.effectAllowed = 'move';
                                        }}
                                        className="inline-flex cursor-grab select-none items-center rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-xs text-ink active:cursor-grabbing"
                                        title="拖出可退回乘客池或移到别的房间"
                                      >
                                        {display || '—'}
                                      </span>
                                    );
                                  }
                                  // 已失效成员（B6）：所属订单已取消/退款/软删——不可拖动，灰色只读 chip
                                  // 标出人名 · 单号 · 状态（服务端 members[] 直接给，见 N5）；保存时原样
                                  // 保留计费，不自动剔除，只有点 × 显式移除才真正从本间房拿掉这个人。
                                  if (invalidPassengerIds.has(pid)) {
                                    const info = invalidMemberInfo.get(pid);
                                    const statusLabel = info ? orderStatusLabel(info.orderStatus) : '已失效';
                                    const display = info ? passengerDisplayName(info.name, info.chineseName) : '—';
                                    return (
                                      <span
                                        key={pid}
                                        className="inline-flex select-none items-center gap-1 rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-xs text-ink-muted"
                                        title={`${info?.orderNumber ?? ''} · 所属订单当前状态：${statusLabel}——保存时原样保留计费，点 × 才真正移除`}
                                      >
                                        {display} · {statusLabel}
                                        {info?.orderNumber && (
                                          <span className="font-mono text-[10px]">（{info.orderNumber}）</span>
                                        )}
                                        <button
                                          type="button"
                                          className="ml-0.5 rounded px-1 text-ink-muted hover:bg-rose-100 hover:text-rose-700"
                                          title="移除失效成员：真正从本间房剔除（需保存生效）"
                                          onClick={() => removeInvalidMember(r.draftId, g.orderId, g.orderItemId, pid)}
                                        >
                                          ×
                                        </button>
                                      </span>
                                    );
                                  }
                                  return null;
                                })}
                              </div>
                            </div>
                          ))
                        )}
                      </div>

                      <input
                        className="input mt-2 w-full py-1.5 text-sm"
                        placeholder="备注（选填）"
                        value={r.notes}
                        onChange={(e) => patchRoom(r.draftId, { notes: e.target.value })}
                      />
                    </div>
                  );
                })}

                <button type="button" onClick={addRoom} className="btn-secondary w-full py-2 text-sm">
                  <Icon name="plus" /> 新建共享房
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── 底部：错误/成功提示 + 操作 ── */}
        <div className="border-t border-slate-200 px-5 py-3">
          {saveErr && (
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
              <span>{saveErr}</span>
              {isConflict && (
                <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={handleManualRefresh}>
                  <Icon name="refresh" /> 刷新
                </button>
              )}
            </div>
          )}
          {saveOk && <div className="mb-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{saveOk}</div>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" className="btn-ghost text-sm" onClick={onClose} disabled={saving}>
              关闭
            </button>
            <button type="button" className="btn-primary text-sm" onClick={() => void handleSave()} disabled={saving || loading || !wb}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
