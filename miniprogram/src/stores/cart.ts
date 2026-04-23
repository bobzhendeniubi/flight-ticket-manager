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
  /** 幂等 key —— 和当前购物车内容绑定，跨组件 remount 稳定，clear() 时重置 */
  idempotencyKey: string | null;
  hydrated: boolean;
  hydrate: () => void;
  add: (item: CartItem) => void;
  remove: (index: number) => void;
  clear: () => void;
  /** 获取（或延迟生成）本次 checkout session 的 idempotency key */
  ensureIdempotencyKey: () => string;
}

const STORAGE_KEY = 'ftm_cart';

interface PersistedShape {
  items: CartItem[];
  idempotencyKey: string | null;
}

function persist(items: CartItem[], idempotencyKey: string | null) {
  try {
    const payload: PersistedShape = { items, idempotencyKey };
    Taro.setStorageSync(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* noop — 小程序 storage 上限 10MB */
  }
}

function genIdempotencyKey(): string {
  return `mp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export const useCart = create<CartState>((set, get) => ({
  items: [],
  idempotencyKey: null,
  hydrated: false,

  hydrate: () => {
    try {
      const raw = Taro.getStorageSync(STORAGE_KEY) as string | undefined;
      if (raw) {
        // 兼容旧格式（直接是 CartItem[]）
        let parsed: PersistedShape;
        const json = JSON.parse(raw);
        if (Array.isArray(json)) {
          parsed = { items: json as CartItem[], idempotencyKey: null };
        } else {
          parsed = json as PersistedShape;
        }
        set({
          items: parsed.items ?? [],
          idempotencyKey: parsed.idempotencyKey ?? null,
          hydrated: true,
        });
      } else {
        set({ hydrated: true });
      }
    } catch {
      set({ hydrated: true });
    }
  },

  // add/remove 都视为"购物车内容变化"→ rotate key
  // 场景：客户端下单成功但没拿到响应 → 用户以为失败、修改购物车再试 →
  // 必须是新 key，否则后端按旧 key 返回旧订单（和新购物车内容不符）
  add: (item) => {
    const items = [...get().items, item];
    persist(items, null);
    set({ items, idempotencyKey: null });
  },

  remove: (index) => {
    const items = get().items.filter((_, i) => i !== index);
    persist(items, null);
    set({ items, idempotencyKey: null });
  },

  clear: () => {
    // clear 既发生在下单成功、也可能是手动清空 —— 都该重置 idempotency key
    persist([], null);
    set({ items: [], idempotencyKey: null });
  },

  ensureIdempotencyKey: () => {
    const current = get().idempotencyKey;
    if (current) return current;
    const next = genIdempotencyKey();
    persist(get().items, next);
    set({ idempotencyKey: next });
    return next;
  },
}));
