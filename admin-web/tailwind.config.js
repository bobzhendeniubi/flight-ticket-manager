/** @type {import('tailwindcss').Config} */
// 「Console」后台设计系统 — 近单色 slate + 克制 indigo 强调（Linear/Vercel 极简工具气质）
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // 唯一强调色：靛蓝（仅用于主按钮 / 当前导航 / 焦点环 / 关键链接）
        brand: {
          DEFAULT: '#4f46e5',
          dark: '#4338ca',
          light: '#eef2ff',
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          600: '#4f46e5',
          700: '#4338ca',
        },
        ink: { DEFAULT: '#0f172a', soft: '#475569', muted: '#94a3b8' },
        canvas: '#f8fafc',
        surface: '#ffffff',
      },
      fontFamily: {
        sans: [
          'Inter',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          '"Noto Sans SC"',
          'system-ui',
          'sans-serif',
        ],
      },
      boxShadow: {
        card: '0 1px 2px rgba(15,23,42,.05)',
        pop: '0 8px 28px -10px rgba(15,23,42,.22)',
      },
      keyframes: {
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
      },
      animation: { 'fade-in': 'fade-in .25s ease both' },
    },
  },
  plugins: [],
};
