import { useCallback, useEffect, useRef, useState } from 'react';

// ── 表格列宽（可拖动、按人记住）──────────────────────────────────────
// 与表头拖柄 ColumnResizeHandle 配套：拖动中只改内存（每帧 setState 重排表格，不碰存储），
// 松手时 persist() 落盘。存储只记「与默认值不同」的列——以后调默认宽，没拖过的列自动跟上。
// 读存储处处兜底：隐私模式抛错 / 坏 JSON / 非数字 / 已下线的列名，一律回落默认值，永远不会把表读坏。
// 不绑定具体表格：别的 table-admin 页面传自己的 storageKey 与默认宽即可复用。

/** 默认最小列宽（px）：再窄连表头两个字都放不下。 */
export const DEFAULT_MIN_COLUMN_WIDTH = 48;
/** 单列上限，防止坏值 / 手滑拖出几万像素把横向滚动条撑没。 */
export const MAX_COLUMN_WIDTH = 2000;

export type ColumnWidths<K extends string> = Readonly<Record<K, number>>;

export function clampColumnWidth(px: number, min: number = DEFAULT_MIN_COLUMN_WIDTH): number {
  if (!Number.isFinite(px)) return min;
  return Math.min(MAX_COLUMN_WIDTH, Math.max(min, Math.round(px)));
}

/**
 * 解析存储里的列宽：只认 defaults 里有的列、只认有限数字；其余（未知列、字符串、NaN）忽略，
 * 过窄/过宽的夹到上下限。raw 为空 / 非对象 / JSON 坏掉 → 全部默认值。
 */
export function parseStoredColumnWidths<K extends string>(
  raw: string | null,
  defaults: ColumnWidths<K>,
  min: number = DEFAULT_MIN_COLUMN_WIDTH,
): ColumnWidths<K> {
  if (!raw) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
  const stored = parsed as Record<string, unknown>;
  const next = { ...defaults } as Record<K, number>;
  for (const key of Object.keys(defaults) as K[]) {
    const v = stored[key];
    if (typeof v === 'number' && Number.isFinite(v)) next[key] = clampColumnWidth(v, min);
  }
  return next;
}

/** 只序列化与默认值不同的列；全是默认 → null（调用方据此删键）。 */
export function serializeColumnWidths<K extends string>(
  widths: ColumnWidths<K>,
  defaults: ColumnWidths<K>,
): string | null {
  const diff: Partial<Record<K, number>> = {};
  let changed = false;
  for (const key of Object.keys(defaults) as K[]) {
    if (widths[key] !== defaults[key]) {
      diff[key] = widths[key];
      changed = true;
    }
  }
  return changed ? JSON.stringify(diff) : null;
}

function readColumnWidths<K extends string>(
  storageKey: string,
  defaults: ColumnWidths<K>,
  min: number,
): ColumnWidths<K> {
  try {
    return parseStoredColumnWidths(window.localStorage.getItem(storageKey), defaults, min);
  } catch {
    return defaults;
  }
}

function writeColumnWidths<K extends string>(
  storageKey: string,
  widths: ColumnWidths<K>,
  defaults: ColumnWidths<K>,
): void {
  try {
    const raw = serializeColumnWidths(widths, defaults);
    if (raw === null) window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, raw);
  } catch {
    // 隐私模式 / 存储写满：本次会话内列宽仍生效，只是下次打开回到默认。
  }
}

export interface UseColumnWidthsResult<K extends string> {
  widths: ColumnWidths<K>;
  /** 只改内存（拖动中每帧调用）；要记住请随后调 persist()。 */
  setWidth: (key: K, px: number) => void;
  /** 把当前列宽落盘（拖动松手 / 键盘调整后调用）。 */
  persist: () => void;
  /** 单列恢复默认并落盘（双击拖柄）。 */
  resetWidth: (key: K) => void;
  /** 全部恢复默认并删存储键。 */
  resetAll: () => void;
}

/**
 * @param storageKey 建议带用户 id（如 `ftm-orders-colwidths:<userId>`），同一台电脑换人登录各记各的。
 * @param defaults   各列默认宽（px）。请传模块级常量或 useMemo 结果——引用变化会被当成换了一套列。
 */
export function useColumnWidths<K extends string>(
  storageKey: string,
  defaults: ColumnWidths<K>,
  options: { min?: number } = {},
): UseColumnWidthsResult<K> {
  const min = options.min ?? DEFAULT_MIN_COLUMN_WIDTH;
  const [widths, setWidths] = useState<ColumnWidths<K>>(() => readColumnWidths(storageKey, defaults, min));
  // 最新列宽的同步副本：persist() 紧跟 setWidth() 调用时 state 还没提交，靠 ref 拿到最新值。
  const widthsRef = useRef(widths);
  const apply = useCallback((next: ColumnWidths<K>) => {
    widthsRef.current = next;
    setWidths(next);
  }, []);

  // 换人登录 / 换表（storageKey 或 defaults 变了）→ 重新读一遍；首次挂载已在 useState 里读过，跳过。
  const loadedRef = useRef({ storageKey, defaults });
  useEffect(() => {
    if (loadedRef.current.storageKey === storageKey && loadedRef.current.defaults === defaults) return;
    loadedRef.current = { storageKey, defaults };
    apply(readColumnWidths(storageKey, defaults, min));
  }, [storageKey, defaults, min, apply]);

  const setWidth = useCallback(
    (key: K, px: number) => {
      const clamped = clampColumnWidth(px, min);
      if (widthsRef.current[key] === clamped) return;
      apply({ ...widthsRef.current, [key]: clamped });
    },
    [min, apply],
  );

  const persist = useCallback(() => {
    writeColumnWidths(storageKey, widthsRef.current, defaults);
  }, [storageKey, defaults]);

  const resetWidth = useCallback(
    (key: K) => {
      const next = { ...widthsRef.current, [key]: defaults[key] };
      apply(next);
      writeColumnWidths(storageKey, next, defaults);
    },
    [storageKey, defaults, apply],
  );

  const resetAll = useCallback(() => {
    apply(defaults);
    writeColumnWidths(storageKey, defaults, defaults);
  }, [storageKey, defaults, apply]);

  return { widths, setWidth, persist, resetWidth, resetAll };
}
