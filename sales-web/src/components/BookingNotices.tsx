import { NOTICE_SECTIONS } from '../lib/notices';

/**
 * 预订须知 / 特殊情况扣损规则 / 值机提示 — 可复用静态展示块。
 * 用在 CheckoutPage 底部和套餐页底部；文案常量见 lib/notices.ts。
 */
export function BookingNotices({ className }: { className?: string }) {
  return (
    <section className={`card bg-slate-50 ${className ?? ''}`}>
      <h2 className="text-sm font-bold text-slate-800">📌 预订须知与温馨提示</h2>
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        {NOTICE_SECTIONS.map((sec) => (
          <div key={sec.title}>
            <h3 className="text-xs font-semibold text-slate-700">
              {sec.emoji} {sec.title}
            </h3>
            <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-slate-600">
              {sec.items.map((item, idx) => (
                <li key={idx} className="flex gap-1.5">
                  <span className="shrink-0 text-slate-400">{idx + 1}.</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
