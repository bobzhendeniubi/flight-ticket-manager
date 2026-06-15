import { NOTICE_SECTIONS } from '../lib/notices';
import { Icon, type IconName } from './Icon';

/**
 * 预订须知 / 特殊情况扣损规则 / 值机提示 — 可复用静态展示块。
 * 用在 CheckoutPage 底部和套餐页底部；文案常量见 lib/notices.ts。
 *
 * 图标按 section 语义就近映射（不改 notices.ts 里存的 emoji 字段，只改渲染）。
 */
function sectionIcon(title: string): IconName {
  if (title.includes('扣损') || title.includes('特殊')) return 'shield';
  if (title.includes('值机') || title.includes('登机')) return 'clock';
  return 'info';
}

export function BookingNotices({ className }: { className?: string }) {
  return (
    <section className={`card bg-canvas ${className ?? ''}`}>
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand">
          <Icon name="info" className="h-4 w-4" />
        </span>
        <div>
          <h2 className="section-title text-base md:text-lg">预订须知与温馨提示</h2>
          <p className="section-sub text-xs">下单前请逐条阅读，避免行程纠纷</p>
        </div>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {NOTICE_SECTIONS.map((sec) => (
          <div
            key={sec.title}
            className="rounded-2xl border border-slate-200/70 bg-surface p-4 shadow-card"
          >
            <h3 className="flex items-center gap-1.5 text-sm font-bold text-ink">
              <Icon name={sectionIcon(sec.title)} className="h-4 w-4 text-brand" />
              {sec.title}
            </h3>
            <ul className="mt-2.5 space-y-2 text-xs leading-relaxed text-ink-soft">
              {sec.items.map((item, idx) => (
                <li key={idx} className="flex gap-2">
                  <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[10px] font-bold text-brand-700 nums">
                    {idx + 1}
                  </span>
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
