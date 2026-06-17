import { BENEFIT_ITEMS } from '../lib/notices';
import { Icon, type IconName } from './Icon';

/**
 * 福利条 — 一行展示"澳门免费接送机 / 积分当钱花 / 累积飞行次数抵机票"等福利。
 * 首页 hero 下方 + 套餐页复用；文案改 lib/notices.ts 的 BENEFIT_ITEMS。
 *
 * 图标按福利文案语义就近映射（不改 notices.ts 里存的 emoji 字段，只改渲染）。
 */
function benefitIcon(text: string): IconName {
  if (text.includes('接送')) return 'car';
  if (text.includes('早') || text.includes('酒店')) return 'hotel';
  if (text.includes('客服')) return 'support';
  return 'sparkles';
}

export function BenefitsStrip({ className }: { className?: string }) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-palm/20 px-4 py-3 text-xs text-ink-soft shadow-warm ${className ?? ''}`}
      style={{ backgroundImage: 'linear-gradient(110deg, #e7f6ee 0%, #fbf4e9 60%, #fff6e6 100%)' }}
    >
      {/* 标签头：暖金小太阳 + 棕榈绿气质 */}
      <span className="inline-flex items-center gap-1.5 rounded-full bg-white/80 px-3 py-1 font-extrabold text-palm shadow-sm">
        <Icon name="sparkles" className="h-3.5 w-3.5 text-sun" />
        福利享不停
      </span>
      {BENEFIT_ITEMS.map((b) => (
        <span key={b.text} className="chip-palm">
          <Icon name={benefitIcon(b.text)} className="h-3.5 w-3.5" />
          {b.text}
        </span>
      ))}
    </div>
  );
}
