/**
 * 购物车 store。可加入：机票班次 / 酒店间夜 / 接送 / 签证 / Bundle。
 *
 * 持久化在 localStorage（key: ftm-cart）。退出登录不清空（让客户重登能继续结账）。
 *
 * 真接 API 后：每次 add/remove 同步到 backend POST /cart，结账走 POST /orders。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { safeRandomUUID } from '../lib/uuid';

export type CartItemKind = 'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA' | 'BUNDLE';

export interface CartItem {
  id: string; // 行 id（每行唯一）
  kind: CartItemKind;
  productId: string; // 产品 id（FLIGHT 用 scheduleId）
  name: string;
  description?: string;
  emoji: string;
  unitPrice: number;
  qty: number;
  meta?: Record<string, string | number | boolean>;
  addedAt: string; // ISO 时间，用于"实时动态"展示
  // 结账勾选 —— 代理可只结一部分，剩下的留在车里。老数据无此字段时按"已勾选"处理。
  selected?: boolean;
}

/** 是否参与本次结账（兼容老数据：未定义 = 选中）*/
export function isSelected(i: CartItem): boolean {
  return i.selected !== false;
}

const CART_KINDS: readonly string[] = ['FLIGHT', 'HOTEL', 'TRANSFER', 'VISA', 'BUNDLE'];

/**
 * 清洗持久化的购物车行。旧版本/被污染的 localStorage 数据（缺 unitPrice、
 * qty 非法、kind 未知等）曾让 Cart/Checkout 渲染抛 TypeError → 整页白屏。
 * 不合法的行静默丢弃；合法行做数值矫正 + 字段兜底。
 */
function sanitizeItems(raw: unknown): CartItem[] {
  if (!Array.isArray(raw)) return [];
  const cleaned: CartItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const it = entry as Record<string, unknown>;
    if (typeof it.id !== 'string') continue;
    if (typeof it.kind !== 'string' || !CART_KINDS.includes(it.kind)) continue;
    const unitPrice = Number(it.unitPrice);
    const qty = Number(it.qty);
    if (!Number.isFinite(unitPrice) || !(qty >= 1)) continue;
    cleaned.push({
      ...(entry as CartItem),
      unitPrice,
      qty,
      selected: typeof it.selected === 'boolean' ? it.selected : true,
      meta:
        typeof it.meta === 'object' && it.meta !== null && !Array.isArray(it.meta)
          ? (it.meta as CartItem['meta'])
          : {},
    });
  }
  return cleaned;
}

interface CartState {
  items: CartItem[];
  add: (item: Omit<CartItem, 'id' | 'addedAt'>) => void;
  remove: (id: string) => void;
  removeMany: (ids: string[]) => void;
  updateQty: (id: string, qty: number) => void;
  toggleSelected: (id: string) => void;
  setAllSelected: (val: boolean) => void;
  clear: () => void;
  total: () => number;
  count: () => number;
}

export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],

      add: (item) => {
        // safeRandomUUID 在 insecure context（http）也能用 —— crypto.randomUUID()
        // 在裸 IP 走 http 时直接调用会抛 DOMException
        const id = `${item.kind}-${item.productId}-${safeRandomUUID()}`;
        set((state) => ({
          items: [
            ...state.items,
            {
              ...item,
              id,
              addedAt: new Date().toISOString(),
              selected: true,
            },
          ],
        }));
        // 简单 UX 反馈
        if (typeof window !== 'undefined') {
          // 触发一个 custom event，Layout 可以监听做"已加入购物车"飘字
          window.dispatchEvent(new CustomEvent('ftm-cart-add', { detail: item }));
        }
      },

      remove: (id) => set((state) => ({ items: state.items.filter((i) => i.id !== id) })),

      removeMany: (ids) =>
        set((state) => ({ items: state.items.filter((i) => !ids.includes(i.id)) })),

      updateQty: (id, qty) =>
        set((state) => ({
          items: state.items.map((i) => (i.id === id ? { ...i, qty: Math.max(1, qty) } : i)),
        })),

      toggleSelected: (id) =>
        set((state) => ({
          items: state.items.map((i) =>
            i.id === id ? { ...i, selected: i.selected === false } : i,
          ),
        })),

      setAllSelected: (val) =>
        set((state) => ({ items: state.items.map((i) => ({ ...i, selected: val })) })),

      clear: () => set({ items: [] }),

      total: () => get().items.reduce((s, i) => s + i.unitPrice * i.qty, 0),

      count: () => get().items.reduce((s, i) => s + i.qty, 0),
    }),
    {
      name: 'ftm-cart',
      // v2：持久化数据带版本号。老数据（无版本/旧版本）经 migrate 清洗后保留合法行
      version: 2,
      partialize: (state) => ({ items: state.items }),
      migrate: (persisted) => ({
        items: sanitizeItems((persisted as { items?: unknown } | null)?.items),
      }),
      // 同版本的数据每次 rehydrate 也清洗一遍（防手改 localStorage / 旧 bug 写入的脏行）
      merge: (persisted, current) => ({
        ...current,
        items: sanitizeItems((persisted as { items?: unknown } | null)?.items),
      }),
    },
  ),
);

export const KIND_INFO: Record<CartItemKind, { label: string; color: string }> = {
  FLIGHT: { label: '机票', color: 'bg-sky-100 text-sky-700' },
  HOTEL: { label: '酒店', color: 'bg-purple-100 text-purple-700' },
  TRANSFER: { label: '接送', color: 'bg-pink-100 text-pink-700' },
  VISA: { label: '签证', color: 'bg-amber-100 text-amber-700' },
  BUNDLE: { label: '套餐', color: 'bg-emerald-100 text-emerald-700' },
};
