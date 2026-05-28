/**
 * i18next 初始化
 *
 * 支持 zh-CN（默认）/ en / vi 三种语言。
 * - 首次访问根据浏览器语言自动选择
 * - 切换后存 localStorage（key: ftm_i18n_lng）
 * - 没翻译的 key fallback 到 zh-CN
 *
 * 用法：
 *   import { useTranslation } from 'react-i18next';
 *   const { t } = useTranslation();
 *   <button>{t('nav.login')}</button>
 *
 * 添加新文案：
 *   1. 编辑 locales/zh-CN.json 加 key
 *   2. 编辑 en.json 和 vi.json 同步翻译（缺的会 fallback）
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
void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    en: { translation: en },
    vi: { translation: vi },
  },
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  supportedLngs: SUPPORTED_LANGUAGES,
  nonExplicitSupportedLngs: true,
  interpolation: { escapeValue: false }, // React 已经 escape，不重复
  react: { useSuspense: false },
});

export default i18n;
