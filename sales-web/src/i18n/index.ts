/**
 * i18next 初始化
 *
 * 当前全站锁定中文（lng='zh-CN'）。页面文案目前全是硬编码中文、en/vi 未完整翻译，
 * 之前按浏览器语言自动切换会导致"导航英文 + 页面中文"一直混着，故关闭。
 *
 * 注意：不要加 supportedLngs + nonExplicitSupportedLngs —— 二者会把 'zh-CN' 归一到 'zh'
 * 去查 resource（resource 是按 'zh-CN' 存的），导致 t() 找不到 key、直接吐出原始 key。
 *
 * 用法：
 *   import { useTranslation } from 'react-i18next';
 *   const { t } = useTranslation();
 *   <button>{t('nav.login')}</button>
 *
 * 未来要真多语言：先把所有页面文案接进 t()，补齐 en/vi.json，再恢复语言检测 + 切换器。
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './locales/zh-CN.json';
import en from './locales/en.json';
import vi from './locales/vi.json';

export const SUPPORTED_LANGUAGES = ['zh-CN', 'en', 'vi'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

// 全站锁定中文：页面文案目前全是硬编码中文，en/vi 未完整翻译。
// 之前用浏览器语言检测 → 英文浏览器的用户首屏导航变英文、页面仍中文 = 一直混着。
// 强制 lng='zh-CN'，不再按浏览器语言切换。（未来要真多语言：把所有页面文案接进 t() 后再恢复检测）
//
// 导出 init promise —— main.tsx 等它 resolve 后再渲染，
// 保证首屏 i18n 已 ready，否则 t() 会输出原始 key（nav.flights 字面量）。
export const i18nReady = i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    en: { translation: en },
    vi: { translation: vi },
  },
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false }, // React 已经 escape，不重复
  react: { useSuspense: false },
});

export default i18n;
