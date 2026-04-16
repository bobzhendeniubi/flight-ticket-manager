/**
 * 购物车 store。可加入：机票班次 / 酒店间夜 / 接送 / 签证 / Bundle。
 *
 * 持久化在 localStorage（key: ftm-cart）。退出登录不清空（让客户重登能继续结账）。
 *
 * 真接 API 后：每次 add/remove 同步到 backend POST /cart，结账走 POST /orders。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
}

interface CartState {
  items: CartItem[];
  add: (item: Omit<CartItem, 'id' | 'addedAt'>) => void;
  remove: (id: string) => void;
  updateQty: (id: string, qty: number) => void;
  clear: () => void;
  total: () => number;
  count: () => number;
}

export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],

      add: (item) => {
        // 用 crypto.randomUUID 保证唯一性（同一毫秒多次添加不会冲突）
        const uniq =
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const id = `${item.kind}-${item.productId}-${uniq}`;
        set((state) => ({
          items: [
            ...state.items,
            {
              ...item,
              id,
              addedAt: new Date().toISOString(),
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

      updateQty: (id, qty) =>
        set((state) => ({
          items: state.items.map((i) => (i.id === id ? { ...i, qty: Math.max(1, qty) } : i)),
        })),

      clear: () => set({ items: [] }),

      total: () => get().items.reduce((s, i) => s + i.unitPrice * i.qty, 0),

      count: () => get().items.reduce((s, i) => s + i.qty, 0),
    }),
    {
      name: 'ftm-cart',
      partialize: (state) => ({ items: state.items }),
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
