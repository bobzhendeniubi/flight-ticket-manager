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
import LanguageDetector from 'i18next-browser-languagedetector';
import zhCN from './locales/zh-CN.json';
import en from './locales/en.json';
import vi from './locales/vi.json';

export const SUPPORTED_LANGUAGES = ['zh-CN', 'en', 'vi'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { translation: zhCN },
      en: { translation: en },
      vi: { translation: vi },
    },
    fallbackLng: 'zh-CN',
    supportedLngs: SUPPORTED_LANGUAGES,
    nonExplicitSupportedLngs: true, // en-US → en
    interpolation: { escapeValue: false }, // React 已经 escape，不重复
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      lookupLocalStorage: 'ftm_i18n_lng',
      caches: ['localStorage'],
    },
    // App 没用 <Suspense> 包，禁用 suspense 让组件在 resources ready 后自动 re-render
    // 否则首次渲染会拿到 raw key（'nav.flights' 字面量），切语言才显示翻译
    react: { useSuspense: false },
  });

export default i18n;
