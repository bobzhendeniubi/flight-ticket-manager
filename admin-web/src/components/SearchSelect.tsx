/**
 * SearchSelect —— 依赖无关的可搜索下拉选择器（Console 设计系统风格）。
 *
 * 解决套餐向导里「原生 <select> 选项太多找不到」的问题：文本框输入即按 label
 * 做不区分大小写的子串过滤，下方列表点选；选项展示 `label · ¥priceLabel`（priceLabel 为空则只展示 label）。
 *
 * 交互约定：
 *   - 未选中：输入框显示搜索关键字，下方即时过滤出选项列表。
 *   - 已选中：输入框显示选中项的 label；重新聚焦/输入会清空展示态、重新按关键字过滤（不会丢已选值，
 *     直到用户真正点选新选项才会触发 onChange；中途失焦/Esc/点外部会保留原选中值）。
 *   - Esc / 点击组件外部：收起下拉，若中途没点选新项则保留原选中值。
 *
 * 只做展示 + 选择，不掌管「选中的 id 对应什么价格」这类业务逻辑——那些由调用方通过
 * options 的 priceLabel 传入，SearchSelect 本身不关心价格口径。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

export interface SearchSelectOption {
  id: string;
  /** 主展示文本（酒店名·房型名 / 接送产品名 / 签证国家·类型等），搜索按此做子串匹配 */
  label: string;
  /** 价格展示后缀（不含 ¥ 符号，由组件统一加上），如 "1880"、"280"；不传或空串 = 该选项不展示价格 */
  priceLabel?: string;
}

export interface SearchSelectProps {
  options: SearchSelectOption[];
  /** 当前选中的 option.id；'' / null = 未选 */
  value: string | null;
  onChange: (id: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export function SearchSelect({
  options,
  value,
  onChange,
  placeholder = '搜索…',
  className,
  disabled,
}: SearchSelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  // query = 用户正在输入的搜索关键字；未聚焦编辑时展示已选项的 label（见下方 displayValue）。
  const [query, setQuery] = useState('');

  const selected = useMemo(() => options.find((o) => o.id === value) ?? null, [options, value]);

  // 输入框展示值：正在搜索（open）→ 用户敲的 query；否则 → 已选项 label 或空。
  const displayValue = open ? query : (selected?.label ?? '');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  // 点击组件外部 → 收起下拉（不清空已选值，未点选新项时保留原选中）。
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  function openForSearch() {
    if (disabled) return;
    setQuery('');
    setOpen(true);
  }

  function selectOption(o: SearchSelectOption) {
    onChange(o.id);
    setQuery('');
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
      inputRef.current?.blur();
    }
  }

  return (
    <div ref={rootRef} className={`relative ${className ?? ''}`}>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          className="input pr-6 text-xs"
          value={displayValue}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={openForSearch}
          onChange={(e) => {
            if (!open) setOpen(true);
            setQuery(e.target.value);
          }}
          onKeyDown={handleKeyDown}
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-ink-muted">
          ▾
        </span>
      </div>
      {open && (
        <div className="absolute left-0 right-0 top-full z-[60] mt-1 max-h-56 overflow-auto rounded-lg border border-slate-200 bg-white py-1 text-xs shadow-pop">
          {filtered.length === 0 && (
            <div className="px-3 py-2 text-ink-muted">无匹配结果</div>
          )}
          {filtered.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`block w-full truncate px-3 py-1.5 text-left hover:bg-brand-50 ${
                o.id === value ? 'bg-brand-50/60 font-medium text-brand-700' : 'text-ink'
              }`}
              onClick={() => selectOption(o)}
            >
              {o.priceLabel ? `${o.label} · ¥${o.priceLabel}` : o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
