/**
 * 购物车 store — 持久化到 Taro.storage。
 *
 * 和 sales-web 的 stores/cart.ts 字段一致，便于未来抽 shared 包。
 */
import { create } from 'zustand';
import Taro from '@tarojs/taro';

export type CartItemKind = 'FLIGHT' | 'HOTEL' | 'TRANSFER' | 'VISA' | 'BUNDLE';

export interface CartItem {
  kind: CartItemKind;
  productId: string;
  name: string;
  description?: string;
  unitPrice: number;
  qty: number;
  meta?: Record<string, unknown>;
}

interface CartState {
  items: CartItem[];
  hydrated: boolean;
  hydrate: () => void;
  add: (item: CartItem) => void;
  remove: (index: number) => void;
  clear: () => void;
}

const STORAGE_KEY = 'ftm_cart';

function persist(items: CartItem[]) {
  try {
    Taro.setStorageSync(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* noop — 小程序 storage 上限 10MB */
  }
}

export const useCart = create<CartState>((set, get) => ({
  items: [],
  hydrated: false,

  hydrate: () => {
    try {
      const raw = Taro.getStorageSync(STORAGE_KEY) as string | undefined;
      if (raw) {
        const items = JSON.parse(raw) as CartItem[];
        set({ items, hydrated: true });
      } else {
        set({ hydrated: true });
      }
    } catch {
      set({ hydrated: true });
    }
  },

  add: (item) => {
    const items = [...get().items, item];
    persist(items);
    set({ items });
  },

  remove: (index) => {
    const items = get().items.filter((_, i) => i !== index);
    persist(items);
    set({ items });
  },

  clear: () => {
    persist([]);
    set({ items: [] });
  },
}));
