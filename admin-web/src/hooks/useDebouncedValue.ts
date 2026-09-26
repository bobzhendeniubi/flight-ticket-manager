import { useEffect, useState } from 'react';

const DEFAULT_DEBOUNCE_MS = 300;

/**
 * 防抖值 hook —— 输入停止 delayMs 后才更新返回值（与 sales-web/src/lib/useDebouncedValue.ts
 * 同语义，两端故意保持一致）。
 *
 * 用于「依赖表单值触发网络请求」的场景：值在 delayMs 内还在变就不提前吐出旧值，
 * 调用方对着防抖后的返回值发请求即可，不必自己攒 setTimeout。
 */
export function useDebouncedValue<T>(value: T, delayMs: number = DEFAULT_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);

  return debounced;
}
