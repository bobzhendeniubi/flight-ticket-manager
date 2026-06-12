import { useEffect, useState } from 'react';

const DEFAULT_DEBOUNCE_MS = 300;

/**
 * 防抖值 hook — 输入停止 delayMs 后才更新返回值。
 * 用于产品关键字搜索（边打字边过滤但不每键触发重算）。
 */
export function useDebouncedValue<T>(value: T, delayMs: number = DEFAULT_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);

  return debounced;
}
