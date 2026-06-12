import { BENEFIT_ITEMS } from '../lib/notices';

/**
 * 福利条 — 一行展示"澳门免费接送机 / 积分当钱花 / 累积飞行次数抵机票"等福利。
 * 首页 hero 下方 + 套餐页复用；文案改 lib/notices.ts 的 BENEFIT_ITEMS。
 */
export function BenefitsStrip({ className }: { className?: string }) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800 ${className ?? ''}`}
    >
      <span className="font-bold">🎁 福利享不停</span>
      {BENEFIT_ITEMS.map((b) => (
        <span key={b.text} className="inline-flex items-center gap-1">
          <span aria-hidden>{b.emoji}</span>
          {b.text}
        </span>
      ))}
    </div>
  );
}
