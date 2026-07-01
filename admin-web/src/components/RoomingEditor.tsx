/**
 * 分房编辑器（拖拽分房）—— 录单后 / 房控页 复用。
 *
 * 业务：把出行人名字拖到「房间盒子」里决定谁和谁一起住。
 *   - 左侧 = 未分房出行人池（可拖回）。
 *   - 右侧 = 房间盒子，每个盒子 = 一个 RoomGroup。
 *   - 拖拽：池 ↔ 盒子、盒子 ↔ 盒子 自由移动出行人。
 *   - 半间（拼房）：每盒可切 0.5 间（如 7 人 3.5 间，1 人也可能占半间）。
 *   - 每盒可填房型 / 备注（如「和某人不分开」）。
 *
 * 保存：onSave 只收「至少 1 名出行人」的盒子，按 RoomGroup 形状回传。
 */
import { useMemo, useState } from 'react';
import type { HotelAvailabilityTier, RoomGroup } from '../lib/api';

// ── 类型 ─────────────────────────────────────────────────────────────────
export interface RoomingPassenger {
  id: string;
  name: string;
  gender?: string | null;
}

interface RoomingEditorProps {
  passengers: RoomingPassenger[];
  initial?: RoomGroup[];
  hotelName?: string;
  /** 该酒店在住宿区间的房量档位（只显档位不显数字，与六档余位同纪律）；null = 不展示。 */
  hotelTier?: HotelAvailabilityTier | null;
  onSave: (groups: RoomGroup[]) => Promise<void>;
  onClose: () => void;
}

// 房量档位文案 + 徽章配色（只看档位，绝不暴露精确余房数字）。
const HOTEL_TIER_BADGE: Record<HotelAvailabilityTier, { label: string; cls: string }> = {
  AMPLE: { label: '房量充足', cls: 'bg-emerald-50 text-emerald-700' },
  TIGHT: { label: '房量紧张', cls: 'bg-sky-50 text-sky-700' },
  LOW: { label: '仅剩少量', cls: 'bg-amber-50 text-amber-700' },
  SOLD_OUT: { label: '已订满', cls: 'bg-rose-50 text-rose-700' },
};

/** 编辑期房间盒子（roomFraction 必有值，保存时回写 RoomGroup）。 */
interface RoomBox {
  id: string;
  roomType: string;
  passengerIds: string[];
  notes: string;
  roomFraction: number;
}

const FULL_ROOM = 1;
const HALF_ROOM = 0.5;

// ── 工具 ─────────────────────────────────────────────────────────────────
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `rg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 'M'/'男' → 男；'F'/'女' → 女；其余不显示。 */
function genderBadge(gender?: string | null): string | null {
  if (!gender) return null;
  const g = gender.trim().toUpperCase();
  if (g === 'M' || g === '男' || g === 'MALE') return '男';
  if (g === 'F' || g === '女' || g === 'FEMALE') return '女';
  return null;
}

/** 把 initial RoomGroup[] 转编辑期盒子；缺省给一个空盒子。 */
function seedBoxes(initial: RoomGroup[] | undefined): RoomBox[] {
  if (!initial || initial.length === 0) {
    return [{ id: newId(), roomType: '', passengerIds: [], notes: '', roomFraction: FULL_ROOM }];
  }
  return initial.map((g) => ({
    id: g.id || newId(),
    roomType: g.roomType ?? '',
    passengerIds: Array.isArray(g.passengerIds) ? [...g.passengerIds] : [],
    notes: g.notes ?? '',
    roomFraction: g.roomFraction === HALF_ROOM ? HALF_ROOM : FULL_ROOM,
  }));
}

// ── 组件 ─────────────────────────────────────────────────────────────────
export function RoomingEditor({ passengers, initial, hotelName, hotelTier, onSave, onClose }: RoomingEditorProps) {
  const [boxes, setBoxes] = useState<RoomBox[]>(() => seedBoxes(initial));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 当前被拖动的出行人 id（HTML5 dataTransfer 兜底用 state，避免某些浏览器读不到）
  const [dragId, setDragId] = useState<string | null>(null);

  const passengerById = useMemo(() => {
    const m = new Map<string, RoomingPassenger>();
    for (const p of passengers) m.set(p.id, p);
    return m;
  }, [passengers]);

  // 已分房的 id 集合 → 推出未分房池
  const assignedIds = useMemo(() => {
    const s = new Set<string>();
    for (const b of boxes) for (const id of b.passengerIds) s.add(id);
    return s;
  }, [boxes]);

  const poolPassengers = passengers.filter((p) => !assignedIds.has(p.id));

  // 占用总间数（半间累加）
  const totalRooms = useMemo(
    () => boxes.filter((b) => b.passengerIds.length > 0).reduce((sum, b) => sum + b.roomFraction, 0),
    [boxes],
  );

  // ── 移动出行人（统一入口：从任意来源移到目标盒子，或回池 target=null）──
  function movePassenger(passengerId: string, targetBoxId: string | null): void {
    setBoxes((prev) => {
      // 先从所有盒子移除
      const stripped = prev.map((b) => ({ ...b, passengerIds: b.passengerIds.filter((id) => id !== passengerId) }));
      if (targetBoxId === null) return stripped; // 回池
      return stripped.map((b) =>
        b.id === targetBoxId && !b.passengerIds.includes(passengerId)
          ? { ...b, passengerIds: [...b.passengerIds, passengerId] }
          : b,
      );
    });
  }

  function handleDragStart(passengerId: string): void {
    setDragId(passengerId);
  }
  function handleDropToBox(boxId: string, e: React.DragEvent): void {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || dragId;
    if (id) movePassenger(id, boxId);
    setDragId(null);
  }
  function handleDropToPool(e: React.DragEvent): void {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || dragId;
    if (id) movePassenger(id, null);
    setDragId(null);
  }

  // ── 房间盒子增删 / 半间 / 房型 / 备注 ──────────────────────────────────
  function addBox(): void {
    setBoxes((prev) => [...prev, { id: newId(), roomType: '', passengerIds: [], notes: '', roomFraction: FULL_ROOM }]);
  }
  function removeBox(boxId: string): void {
    setBoxes((prev) => (prev.length <= 1 ? prev : prev.filter((b) => b.id !== boxId)));
  }
  function toggleHalf(boxId: string): void {
    setBoxes((prev) =>
      prev.map((b) => (b.id === boxId ? { ...b, roomFraction: b.roomFraction === HALF_ROOM ? FULL_ROOM : HALF_ROOM } : b)),
    );
  }
  function patchBox(boxId: string, patch: Partial<Pick<RoomBox, 'roomType' | 'notes'>>): void {
    setBoxes((prev) => prev.map((b) => (b.id === boxId ? { ...b, ...patch } : b)));
  }

  // ── 保存 ───────────────────────────────────────────────────────────────
  async function handleSave(): Promise<void> {
    const groups: RoomGroup[] = boxes
      .filter((b) => b.passengerIds.length > 0)
      .map((b) => ({
        id: b.id,
        hotelName: hotelName ?? '',
        roomType: b.roomType.trim(),
        passengerIds: b.passengerIds,
        ...(b.notes.trim() ? { notes: b.notes.trim() } : {}),
        ...(b.roomFraction === HALF_ROOM ? { roomFraction: HALF_ROOM } : {}),
      }));
    setSaving(true);
    setErr(null);
    try {
      await onSave(groups);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '分房保存失败');
    } finally {
      setSaving(false);
    }
  }

  // ── 渲染一枚出行人 chip ──────────────────────────────────────────────────
  function PassengerChip({ p }: { p: RoomingPassenger }) {
    const g = genderBadge(p.gender);
    return (
      <span
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', p.id);
          e.dataTransfer.effectAllowed = 'move';
          handleDragStart(p.id);
        }}
        onDragEnd={() => setDragId(null)}
        className="inline-flex cursor-grab select-none items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-sm text-ink shadow-sm transition hover:border-brand/40 hover:bg-brand-50 active:cursor-grabbing"
        title="拖到右侧房间盒子"
      >
        <span className="font-medium">{p.name}</span>
        {g && (
          <span className={`text-xs ${g === '男' ? 'text-brand-700' : 'text-rose-600'}`}>{g}</span>
        )}
      </span>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-ink">分房（拖名字到房间）</h3>
          {hotelName ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-ink">🏨 {hotelName}</span>
              {hotelTier && (
                <span className={`badge ${HOTEL_TIER_BADGE[hotelTier].cls}`}>
                  {HOTEL_TIER_BADGE[hotelTier].label}
                </span>
              )}
            </div>
          ) : null}
          <p className="mt-0.5 text-xs text-ink-muted">
            把出行人拖到右侧房间盒子，决定谁和谁一起住。拼房可切「半间」。
          </p>
        </div>
        <div className="text-xs text-ink-soft">
          占用 <b className="text-ink">{totalRooms}</b> 间 · 共 {passengers.length} 人
        </div>
      </div>

      {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}

      <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
        {/* ── 左：未分房池 ── */}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDropToPool}
          className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-3"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">未分房</span>
            <span className="badge-neutral">{poolPassengers.length}</span>
          </div>
          {poolPassengers.length === 0 ? (
            <div className="py-6 text-center text-xs text-ink-muted">全部已分房 · 可拖回此处</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {poolPassengers.map((p) => (
                <PassengerChip key={p.id} p={p} />
              ))}
            </div>
          )}
        </div>

        {/* ── 右：房间盒子 ── */}
        <div className="space-y-3">
          {boxes.map((b, idx) => (
            <div
              key={b.id}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleDropToBox(b.id, e)}
              className="rounded-xl border border-slate-200 bg-surface p-3 shadow-sm transition hover:border-brand/30"
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm font-medium text-ink">
                  房间 {idx + 1}
                  {b.roomFraction === HALF_ROOM && <span className="badge-warning">½ 半间</span>}
                  <span className="text-xs font-normal text-ink-muted">{b.passengerIds.length} 人</span>
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => toggleHalf(b.id)}
                    className={`rounded-md border px-2 py-1 text-xs transition ${
                      b.roomFraction === HALF_ROOM
                        ? 'border-amber-300 bg-amber-50 text-amber-700'
                        : 'border-slate-200 bg-white text-ink-soft hover:bg-slate-50'
                    }`}
                  >
                    半间(拼房)
                  </button>
                  <button
                    type="button"
                    onClick={() => removeBox(b.id)}
                    disabled={boxes.length <= 1 || b.passengerIds.length > 0}
                    className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-ink-soft transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                    title={b.passengerIds.length > 0 ? '先把人移走再删房间' : '删除空房间'}
                  >
                    删房间
                  </button>
                </div>
              </div>

              {/* 盒子里的出行人 chips（可拖出） */}
              <div className="min-h-[2.5rem] rounded-lg border border-dashed border-slate-200 bg-slate-50/50 p-2">
                {b.passengerIds.length === 0 ? (
                  <div className="py-1 text-center text-xs text-ink-muted">把出行人拖到这里</div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {b.passengerIds.map((id) => {
                      const p = passengerById.get(id);
                      if (!p) return null;
                      return <PassengerChip key={id} p={p} />;
                    })}
                  </div>
                )}
              </div>

              {/* 房型 + 备注 */}
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <input
                  className="input py-1.5 text-sm"
                  placeholder="房型（选填，如 大床房 / 双床房）"
                  value={b.roomType}
                  onChange={(e) => patchBox(b.id, { roomType: e.target.value })}
                />
                <input
                  className="input py-1.5 text-sm"
                  placeholder="备注（选填，如「和某人不分开」）"
                  value={b.notes}
                  onChange={(e) => patchBox(b.id, { notes: e.target.value })}
                />
              </div>
            </div>
          ))}

          <button type="button" onClick={addBox} className="btn-secondary w-full py-2 text-sm">
            + 加房间
          </button>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-slate-200 pt-3">
        <button type="button" className="btn-ghost text-sm" onClick={onClose} disabled={saving}>
          取消
        </button>
        <button type="button" className="btn-primary text-sm" onClick={handleSave} disabled={saving}>
          {saving ? '保存中…' : '保存分房'}
        </button>
      </div>
    </div>
  );
}
