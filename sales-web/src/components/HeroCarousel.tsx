import { useEffect, useState } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * 首页 hero 轮播 — 3 张 slide 自动播放 + 圆点切换。
 *
 * - 动画只用 transform: translateX（compositor-friendly，不动 layout 属性）
 * - hover 暂停自动播放；prefers-reduced-motion 时不自动播放
 * - 图片加载失败时只剩渐变底（与旧静态 hero 同款渐变，不会白屏）
 */
const AUTO_ADVANCE_MS = 5000;

interface HeroSlide {
  photo: string;
  gradient: string;
  /** kicker 前的线性图标（取代原 emoji，保持 OTA 干净气质） */
  kickerIcon: IconName;
  kicker: string;
  title: string;
  subtitle: string;
  chips: string[];
}

const HERO_SLIDES: HeroSlide[] = [
  {
    photo: 'https://images.unsplash.com/photo-1559592413-7cec4d0cae2b?w=1600&h=600&fit=crop',
    gradient: 'from-sky-600/85 to-emerald-500/70',
    kickerIcon: 'plane',
    kicker: '澳门出发 · 岘港专线',
    title: '澳门 ⇌ 越南 商务自由行专属',
    subtitle: '自营 QH9588 / QH9589 澳门 ↔ 岘港直飞 1h45m，每天 1 班，说走就走。',
    chips: ['美溪海滩', '巴拿山', '会安古城'],
  },
  {
    photo: 'https://images.unsplash.com/photo-1582719508461-905c673771fd?w=1600&h=600&fit=crop',
    gradient: 'from-emerald-600/85 to-teal-500/70',
    kickerIcon: 'package',
    kicker: '全包套餐 · 明白消费',
    title: '一价全含 · 拎包出发',
    subtitle: '往返机票 · 签证 · 酒店含早 · 中文客服 · 当地地面服务，一次订齐不操心。',
    chips: ['酒店含双早', '签证代办', '当地地面服务'],
  },
  {
    photo: 'https://images.unsplash.com/photo-1540541338287-41700207dee6?w=1600&h=600&fit=crop',
    gradient: 'from-indigo-600/85 to-sky-500/70',
    kickerIcon: 'sparkles',
    kicker: '会员福利',
    title: '福利享不停',
    subtitle: '澳门免费接送机 · 中文客服全程护航 · 会员积分体系筹备中。',
    chips: ['澳门免费接送机', '中文客服全程护航', '积分体系筹备中'],
  },
];

export function HeroCarousel({ greeting }: { greeting?: string | null }) {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    // 用户系统偏好"减少动态效果"时不自动轮播（仍可点圆点切换）
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    const t = setInterval(() => setIdx((i) => (i + 1) % HERO_SLIDES.length), AUTO_ADVANCE_MS);
    return () => clearInterval(t);
  }, [paused]);

  return (
    <section
      className="relative overflow-hidden rounded-3xl shadow-pop"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-roledescription="轮播"
    >
      <div
        className="flex transition-transform duration-700 ease-out"
        style={{ transform: `translateX(-${idx * 100}%)` }}
      >
        {HERO_SLIDES.map((s, i) => (
          <div key={s.title} className="relative w-full flex-shrink-0" aria-hidden={i !== idx}>
            <img
              src={s.photo}
              alt=""
              width={1600}
              height={600}
              loading={i === 0 ? 'eager' : 'lazy'}
              className="absolute inset-0 h-full w-full object-cover"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
            <div className={`absolute inset-0 bg-gradient-to-br ${s.gradient}`} />
            <div className="relative flex min-h-[240px] flex-col justify-center p-6 pb-11 text-white md:min-h-[300px] md:p-12 md:pb-14">
              <div className="inline-flex w-fit items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white/95 backdrop-blur md:text-sm">
                <Icon name={s.kickerIcon} className="h-3.5 w-3.5 md:h-4 md:w-4" />
                {greeting ? `${greeting}，您好 · ` : ''}
                {s.kicker}
              </div>
              <h1 className="mt-3 text-2xl font-extrabold leading-tight drop-shadow-sm md:text-4xl">{s.title}</h1>
              <p className="mt-2.5 max-w-2xl text-sm text-white/90 md:text-base">{s.subtitle}</p>
              <div className="mt-4 flex flex-wrap gap-2 text-xs md:text-sm">
                {s.chips.map((c) => (
                  <span key={c} className="rounded-full bg-white/20 px-3 py-1.5 font-medium backdrop-blur ring-1 ring-white/15">
                    {c}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 圆点指示器 */}
      <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 gap-2">
        {HERO_SLIDES.map((s, i) => (
          <button
            key={s.title}
            type="button"
            aria-label={`切换到第 ${i + 1} 张：${s.title}`}
            aria-current={i === idx}
            onClick={() => setIdx(i)}
            className={`h-2.5 w-2.5 rounded-full transition-transform duration-300 ${
              i === idx ? 'scale-125 bg-white' : 'bg-white/50 hover:bg-white/80'
            }`}
          />
        ))}
      </div>
    </section>
  );
}
