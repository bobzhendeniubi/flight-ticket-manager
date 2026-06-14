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
        // 评分 / 徽章：暖琥珀
        sun: { DEFAULT: '#ff9f1c', light: '#fff6e6' },
        // 文本与画布
        ink: { DEFAULT: '#0f1b2d', soft: '#475569', muted: '#8a99ad' },
        canvas: '#f5f8fb',
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
      },
      animation: {
        'fade-up': 'fade-up .45s cubic-bezier(.16,1,.3,1) both',
        'fade-in': 'fade-in .4s ease both',
        float: 'float 6s ease-in-out infinite',
        shimmer: 'shimmer 1.4s linear infinite',
      },
    },
  },
  plugins: [],
};
