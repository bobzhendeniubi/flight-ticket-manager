/** @type {import('tailwindcss').Config} */
// 「Sunlit Coast」前台设计系统 — 海洋蓝绿 + 日落珊瑚（OTA / 携程·Klook 气质，海岛专线）
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // 品牌：海洋（澳门⇌岘港海岛专线）
        brand: {
          DEFAULT: '#0e8aa0',
          dark: '#0a6e80',
          50: '#ecfbfd',
          100: '#cef3f8',
          200: '#a2e6ef',
          300: '#67d2e1',
          400: '#2fb6cb',
          500: '#129bb2',
          600: '#0e8aa0',
          700: '#116576',
          800: '#145260',
          900: '#143f49',
        },
        // 促销 / 价格：日落珊瑚（CTA、立减、价格）
        deal: {
          DEFAULT: '#ff5a3c',
          dark: '#e8421f',
          light: '#fff1ee',
        },
        // 评分 / 徽章：暖琥珀（+ glow = 日轮暖光，hero 右上角 sun-glow 用）
        sun: { DEFAULT: '#ff9f1c', light: '#fff6e6', glow: '#ffd27a' },
        // 椰岛扩展色（在 Sunlit Coast 基础上加，不替换）
        lagoon: { DEFAULT: '#19b8c9', light: '#eafaff' }, // 明亮海/天（沙滩近岸的青绿）
        palm: { DEFAULT: '#1f8a5b', light: '#e7f6ee' }, // 棕榈绿（含早/直飞/福利 chip、叶片点缀）
        sand: { DEFAULT: '#f3e7d3', light: '#fbf4e9' }, // 暖沙色面（不再冷白）
        // 文本与画布
        ink: { DEFAULT: '#0f1b2d', soft: '#475569', muted: '#8a99ad' },
        canvas: '#f5f8fb',
        canvasWarm: '#fbf6ee', // 页面暖底（取代偏冷的 #f5f8fb 体感）
        surface: '#ffffff',
      },
      fontFamily: {
        sans: [
          'Manrope',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          '"Noto Sans SC"',
          'system-ui',
          'sans-serif',
        ],
        // 仅用于 Latin 展示位（.text-display）：可变衬线，带 opsz 视觉尺寸轴
        display: [
          'Fraunces',
          'Georgia',
          '"Times New Roman"',
          'serif',
        ],
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.125rem',
        '3xl': '1.5rem',
      },
      boxShadow: {
        card: '0 1px 2px rgba(15,27,45,.04), 0 8px 24px -16px rgba(15,27,45,.22)',
        lift: '0 14px 40px -16px rgba(12,142,164,.35)',
        pop: '0 18px 50px -16px rgba(15,27,45,.28)',
        deal: '0 10px 28px -10px rgba(255,90,60,.45)',
        // 暖色软阴影（沙色卡 card-warm 用）：偏暖的褐金色调，不刺眼
        warm: '0 2px 6px rgba(160,110,40,.06), 0 16px 40px -20px rgba(160,110,40,.30)',
        'warm-lift': '0 20px 48px -18px rgba(160,110,40,.40)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'none' },
        },
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        float: {
          '0%,100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-400px 0' },
          '100%': { backgroundPosition: '400px 0' },
        },
        // ── 椰岛 hero 加载序列 + 永续轻动效（仅 transform/opacity，合成器友好）──
        // rise：搜索卡/元素从下方升起淡入（hero 加载序列收尾）
        rise: {
          '0%': { opacity: '0', transform: 'translateY(24px)' },
          '100%': { opacity: '1', transform: 'none' },
        },
        // sunGlow：右上角暖光缓慢呼吸（缩放 + 透明度脉动）
        sunGlow: {
          '0%,100%': { opacity: '0.85', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.08)' },
        },
        // waveDrift：波浪分隔横向缓慢漂移（标志性海岛母题）
        waveDrift: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-25%)' },
        },
        // sway：棕榈叶 / 软元素轻微摆动（旋转幅度极小）
        sway: {
          '0%,100%': { transform: 'rotate(-2.5deg)' },
          '50%': { transform: 'rotate(2.5deg)' },
        },
        // driftX：通用横向轻飘（云/光斑）
        driftX: {
          '0%,100%': { transform: 'translateX(0)' },
          '50%': { transform: 'translateX(14px)' },
        },
      },
      animation: {
        'fade-up': 'fade-up .45s cubic-bezier(.16,1,.3,1) both',
        'fade-in': 'fade-in .4s ease both',
        float: 'float 6s ease-in-out infinite',
        shimmer: 'shimmer 1.4s linear infinite',
        // hero 加载序列（一次性，both 保留终态）
        rise: 'rise .7s cubic-bezier(.16,1,.3,1) both',
        // 永续轻动效（infinite）
        'sun-glow': 'sunGlow 7s ease-in-out infinite',
        'wave-drift': 'waveDrift 14s linear infinite',
        sway: 'sway 6s ease-in-out infinite',
        'drift-x': 'driftX 9s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
