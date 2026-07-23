import { useMemo, useState } from 'react';
import { NumberInput } from './NumberInput';

export interface UsdRateInputProps {
  onFill: (cny: number) => void;
}

/** 美金报价换算为入账用人民币；换算只发生在前端，不改变成本字段语义。 */
export function UsdRateInput({ onFill }: UsdRateInputProps) {
  const [usd, setUsd] = useState<number | null>(null);
  const [rate, setRate] = useState<number | null>(null);

  const roundedCny = useMemo(() => {
    if (usd == null || rate == null || !Number.isFinite(usd) || !Number.isFinite(rate)) {
      return null;
    }
    return Math.round(usd * rate * 100) / 100;
  }, [rate, usd]);

  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap text-xs text-slate-600">
      <span>$</span>
      <NumberInput
        className="w-16 rounded border border-slate-200 px-1 py-0.5 text-right text-xs nums focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand/20"
        step={0.01}
        min={0}
        value={usd}
        onChange={(n) => setUsd(n == null ? null : Math.round(n * 100) / 100)}
        placeholder="美金"
      />
      <span>×</span>
      <NumberInput
        className="w-20 rounded border border-slate-200 px-1 py-0.5 text-right text-xs nums focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand/20"
        step={0.0001}
        min={0}
        value={rate}
        onChange={(n) => setRate(n == null ? null : Math.round(n * 10000) / 10000)}
        placeholder="汇率"
      />
      <span>→ ¥</span>
      <output className="w-14 text-right tabular-nums" aria-label="换算人民币">
        {roundedCny == null ? '—' : roundedCny.toFixed(2)}
      </output>
      <button
        type="button"
        className="rounded border border-brand/30 px-1.5 py-0.5 text-brand disabled:cursor-not-allowed disabled:opacity-40"
        disabled={roundedCny == null}
        onClick={() => {
          if (roundedCny != null) onFill(roundedCny);
        }}
      >
        填入
      </button>
    </div>
  );
}
