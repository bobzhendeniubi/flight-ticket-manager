import { useEffect, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { WaveDivider } from './WaveDivider';

/**
 * 椰岛 hero 轮播 —— 落地页中心舞台。
 *
 * 美学：「踏出机舱，岘港的阳光迎面而来」的海岛逃离感。
 *  - 真实热带岘港照片（美溪海滩 / 礁湖 / 度假泳池 / 巴拿金桥 / 会安灯笼）
 *  - palette 配色渐变 scrim（保证白字对比度）
 *  - 右上角暖阳辉光 sun-glow（缓慢呼吸）+ 太阳圆盘 + 棕榈叶剪影（轻摆）
 *  - 底部漂移波浪分隔（标志性海岛母题）
 *  - 一次性加载序列：天幕淡入 → kicker/标题/副标题分级 fade-up（~70ms 阶梯）
 *
 * 动效纪律：只用 transform/opacity（合成器友好）。
 *  - 自动轮播：translateX 切片，hover 暂停。
 *  - prefers-reduced-motion：不自动轮播；CSS 全局守卫停掉所有大气层动画。
 *  - 圆点指示器：可点切换，aria-current 同步。
 * 图片加载失败 → 只剩 palette 渐变底（不白屏）。
 */
const AUTO_ADVANCE_MS = 5000;

interface HeroSlide {
  photo: string;
  /** palette 配色斜向渐变 scrim（确保白字对比度）。 */
  scrim: string;
  /** kicker 前的线性图标 */
  kickerIcon: IconName;
  /** kicker 英文（Fraunces 展示字） */
  kickerEn: string;
  /** kicker 中文 */
  kicker: string;
  title: string;
  subtitle: string;
  chips: string[];
}

// 真实热带岘港 / 越南海岛意象（Unsplash）。首图 eager + fetchpriority，其余 lazy。
const HERO_SLIDES: HeroSlide[] = [
  {
    // 美溪海滩 My Khe — 碧蓝海水 + 白沙
    photo: 'https://images.unsplash.com/photo-1528127269322-539801943592?w=1600&h=720&fit=crop',
    scrim: 'linear-gradient(105deg, rgba(10,110,128,.78) 0%, rgba(14,138,160,.55) 46%, rgba(25,184,201,.28) 100%)',
    kickerIcon: 'plane',
    kickerEn: 'COCO HOLIDAY · DA NANG',
    kicker: '澳门出发 · 岘港专线',
    title: '说走就走的海岛假期',
    subtitle: '澳门 ↔ 岘港每日直飞 1h45m，落地就是海。机票 · 酒店 · 签证 · 接送，一次订齐。',
    chips: ['美溪海滩', '巴拿山金桥', '会安古城'],
  },
  {
    // 度假泳池 / 棕榈树 — 一价全含的度假感
    photo: 'https://images.unsplash.com/photo-1582719508461-905c673771fd?w=1600&h=720&fit=crop',
    scrim: 'linear-gradient(105deg, rgba(31,138,91,.78) 0%, rgba(14,138,160,.55) 48%, rgba(255,210,122,.22) 100%)',
    kickerIcon: 'package',
    kickerEn: 'ALL-INCLUSIVE',
    kicker: '一价全含 · 明白消费',
    title: '拎包就走 · 全程不操心',
    subtitle: '往返机票 · 酒店含双早 · 签证代办 · 当地接送 · 中文客服全程在线，价格一次说清。',
    chips: ['酒店含双早', '签证代办', '当地接送'],
  },
  {
    // 会安灯笼夜景 — 目的地浪漫
    photo: 'https://images.unsplash.com/photo-1559592413-7cec4d0cae2b?w=1600&h=720&fit=crop',
    scrim: 'linear-gradient(105deg, rgba(20,63,73,.80) 0%, rgba(14,138,160,.52) 50%, rgba(255,159,28,.24) 100%)',
    kickerIcon: 'sparkles',
    kickerEn: 'PERKS & SERVICE',
    kicker: '会员福利',
    title: '福利享不停',
    subtitle: '澳门免费接送机 · 中文客服全程护航 · 会员积分体系筹备中，常飞更划算。',
    chips: ['澳门免费接送机', '中文客服护航', '积分体系筹备中'],
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
      className="relative overflow-hidden rounded-[1.75rem] shadow-pop"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-roledescription="轮播"
    >
      {/* 切片轨道：translateX 横移（合成器友好） */}
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
              height={720}
              loading={i === 0 ? 'eager' : 'lazy'}
              // 首图高优先级抓取（首屏 LCP）；其余懒加载
              {...(i === 0 ? { fetchpriority: 'high' as const } : {})}
              decoding="async"
              className="absolute inset-0 h-full w-full object-cover"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
            {/* palette 配色 scrim：保证白字对比度（左深→右透，文字在左侧） */}
            <div className="absolute inset-0" style={{ backgroundImage: s.scrim }} />
            {/* 极淡颗粒纹理，添空气感 */}
            <div className="grain pointer-events-none absolute inset-0" aria-hidden />

            <div className="relative flex min-h-[300px] flex-col justify-center p-6 pb-14 text-white md:min-h-[400px] md:p-14 md:pb-16">
              {/* 加载序列①：kicker（eyebrow，英文走 Fraunces 展示字） */}
              <div
                className="inline-flex w-fit items-center gap-2 rounded-full bg-white/15 px-3.5 py-1.5 text-xs font-semibold text-white/95 ring-1 ring-white/25 backdrop-blur md:text-sm animate-rise"
                style={{ animationDelay: '60ms' }}
              >
                <Icon name={s.kickerIcon} className="h-3.5 w-3.5 md:h-4 md:w-4" />
                <span className="text-display tracking-[0.18em]">{s.kickerEn}</span>
                <span className="text-white/55" aria-hidden>·</span>
                <span>
                  {greeting ? `${greeting}，您好 · ` : ''}
                  {s.kicker}
                </span>
              </div>

              {/* 加载序列②：大标题（中文，字重 800 + 紧字距 + 大字号对比） */}
              <h1
                className="mt-4 max-w-2xl text-3xl font-extrabold leading-[1.08] tracking-tight drop-shadow-[0_2px_12px_rgba(0,0,0,0.3)] md:text-5xl animate-rise"
                style={{ animationDelay: '140ms', fontWeight: 800 }}
              >
                {s.title}
              </h1>

              {/* 加载序列③：副标题 */}
              <p
                className="mt-3 max-w-2xl text-sm leading-relaxed text-white/90 md:text-lg animate-rise"
                style={{ animationDelay: '210ms' }}
              >
                {s.subtitle}
              </p>

              {/* 加载序列④：福利 chips（棕榈绿语义，但在深色海景上用半透明白底保持对比） */}
              <div
                className="mt-5 flex flex-wrap gap-2 text-xs md:text-sm animate-rise"
                style={{ animationDelay: '280ms' }}
              >
                {s.chips.map((c) => (
                  <span
                    key={c}
                    className="inline-flex items-center gap-1.5 rounded-full bg-white/18 px-3 py-1.5 font-medium ring-1 ring-white/20 backdrop-blur"
                  >
                    <Icon name="check" className="h-3.5 w-3.5 text-emerald-200" />
                    {c}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── 大气层装饰（绝对定位，覆盖整个 hero，不随切片移动）── */}
      {/* 右上角暖阳辉光（缓慢呼吸） */}
      <div
        aria-hidden
        className="sun-glow pointer-events-none absolute -right-16 -top-16 h-64 w-64 md:-right-20 md:-top-20 md:h-80 md:w-80"
      />
      {/* 太阳圆盘（暖金，半透明，与辉光叠成日轮） */}
      <div
        aria-hidden
        className="pointer-events-none absolute right-8 top-8 h-16 w-16 rounded-full md:right-12 md:top-12 md:h-24 md:w-24"
        style={{
          background: 'radial-gradient(circle at 38% 35%, rgba(255,232,180,.95), rgba(255,200,110,.55) 60%, rgba(255,200,110,0) 75%)',
        }}
      />
      {/* 棕榈叶剪影（右下，轻摆 sway）— 内联 SVG，深绿半透明 */}
      <svg
        aria-hidden
        viewBox="0 0 120 120"
        className="pointer-events-none absolute -right-2 bottom-6 hidden h-28 w-28 origin-bottom-right text-emerald-900/25 animate-sway md:block"
        style={{ filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.15))' }}
      >
        <g fill="currentColor">
          <path d="M110 116 C92 78 70 54 36 44 C66 40 96 58 110 96 Z" />
          <path d="M110 116 C100 70 92 40 70 14 C92 26 108 60 112 100 Z" />
          <path d="M110 116 C116 80 118 50 110 18 C120 44 122 84 116 110 Z" />
          <path d="M110 116 C90 92 64 78 28 76 C58 64 96 76 112 104 Z" />
        </g>
      </svg>

      {/* 底部漂移波浪分隔（标志性海岛母题）— 暖底色，承接页面 */}
      <WaveDivider fill="#fbf6ee" height={44} className="z-[1]" />

      {/* 圆点指示器（在波浪之上） */}
      <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 gap-2">
        {HERO_SLIDES.map((s, i) => (
          <button
            key={s.title}
            type="button"
            aria-label={`切换到第 ${i + 1} 张：${s.title}`}
            aria-current={i === idx}
            onClick={() => setIdx(i)}
            className={`h-2.5 rounded-full transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 ${
              i === idx ? 'w-6 bg-white' : 'w-2.5 bg-white/50 hover:bg-white/80'
            }`}
          />
        ))}
      </div>
    </section>
  );
}
