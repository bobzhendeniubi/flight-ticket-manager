import { useId } from 'react';

/**
 * 排序下拉（对标 Klook/携程 列表排序）。
 * 用 input 类样式包一个原生 select，紧凑、移动端友好。
 * 纯展示：选中值/选项走 props，变更走 onChange 回调。
 */
export interface SortOption {
  value: string;
  label: string;
}

export interface SortSelectProps {
  value: string;
  options: SortOption[];
  onChange: (value: string) => void;
  label?: string;
}

export function SortSelect({ value, options, onChange, label = '排序' }: SortSelectProps) {
  const id = useId();
  return (
    <div className="inline-flex items-center gap-2">
      <label htmlFor={id} className="shrink-0 text-xs font-semibold text-ink-soft">
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          className="input appearance-none py-2 pl-3 pr-8 text-sm"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {/* 自绘下拉箭头（appearance-none 后补） */}
        <svg
          className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
    </div>
  );
}
