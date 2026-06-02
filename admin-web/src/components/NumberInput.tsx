/**
 * 数字输入框 —— 解决全站 `<input type="number" value={n}
 * onChange={(e) => set(Number(e.target.value) || 0)}>` 反模式的问题：
 *
 * 旧反模式：
 *   - 清空 → `Number('')` 是 NaN → `|| 0` 强制塞回 0
 *   - 用户无法 backspace 全清后重新输入
 *   - 在某些键盘竞争下还能让 `10000` 莫名其妙变成 `9999`（疑似 F6 根因）
 *
 * 这里底层用 type=text + inputMode 唤起数字键盘，内部用 string state 保留
 * 中间态（如 "1." / ""），对外只 emit number | null。
 *
 * 对外约定：
 *   - `value: number | null`，null 表示空
 *   - `onChange(n: number | null)`，空输入 → null
 *   - `min/max/step` 仅作 hint，不强校验（由表单提交时校验或浏览器原生处理）
 *   - 默认不允许负数 / 允许小数；可用 `integerOnly` / `allowNegative` 切换
 */
import { useEffect, useState, type ChangeEvent } from 'react';

export interface NumberInputProps {
  value: number | null;
  onChange: (n: number | null) => void;
  placeholder?: string;
  /** hint 仅展示用，不强制校验（让表单层处理） */
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  /** true = 只接受整数（默认 false 允许小数） */
  integerOnly?: boolean;
  /** true = 允许负数（默认 false） */
  allowNegative?: boolean;
}

/** 解析 text → number | null（中间态如 ""/"-"/"." 视为 null） */
function parseInput(raw: string): number | null {
  if (raw === '' || raw === '-' || raw === '.' || raw === '-.') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 把外部 value 序列化成 text；null → "" */
function valueToText(v: number | null): string {
  return v == null ? '' : String(v);
}

export function NumberInput({
  value,
  onChange,
  placeholder,
  min,
  max,
  step,
  className,
  disabled,
  required,
  id,
  integerOnly = false,
  allowNegative = false,
}: NumberInputProps) {
  // text 是输入框真实显示的字符串。可能是中间态如 "1." / "" / "-" 等
  const [text, setText] = useState<string>(valueToText(value));

  // 外部 value 变化时同步 text —— 但保留用户正在输入的中间态
  useEffect(() => {
    const parsed = parseInput(text);
    if (parsed !== value) {
      setText(valueToText(value));
    }
    // intentionally only on external value change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function handleChange(e: ChangeEvent<HTMLInputElement>): void {
    const raw = e.target.value;
    let pattern: RegExp;
    if (integerOnly) {
      pattern = allowNegative ? /^-?\d*$/ : /^\d*$/;
    } else {
      pattern = allowNegative ? /^-?\d*\.?\d*$/ : /^\d*\.?\d*$/;
    }
    if (!pattern.test(raw)) return; // illegal char, drop silently
    setText(raw);
    onChange(parseInput(raw));
  }

  return (
    <input
      type="text"
      inputMode={integerOnly ? 'numeric' : 'decimal'}
      autoComplete="off"
      value={text}
      onChange={handleChange}
      placeholder={placeholder}
      className={className}
      disabled={disabled}
      required={required}
      id={id}
      data-min={min}
      data-max={max}
      data-step={step}
    />
  );
}
