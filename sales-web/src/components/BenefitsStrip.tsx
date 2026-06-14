import { BENEFIT_ITEMS } from '../lib/notices';

/**
 * 福利条 — 一行展示"澳门免费接送机 / 积分当钱花 / 累积飞行次数抵机票"等福利。
 * 首页 hero 下方 + 套餐页复用；文案改 lib/notices.ts 的 BENEFIT_ITEMS。
 */
export function BenefitsStrip({ className }: { className?: string }) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-sun/30 bg-sun-light px-4 py-3 text-xs text-amber-800 shadow-card ${className ?? ''}`}
    >
      <span className="inline-flex items-center gap-1 rounded-full bg-white/70 px-2.5 py-1 font-extrabold text-amber-900">
        🎁 福利享不停
      </span>
      {BENEFIT_ITEMS.map((b) => (
        <span key={b.text} className="inline-flex items-center gap-1.5 font-medium">
          <span aria-hidden className="text-sm">{b.emoji}</span>
          {b.text}
        </span>
      ))}
    </div>
  );
}
