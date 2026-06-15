/**
 * i18next 初始化（基础设施层 —— 检测 + 持久化，默认 zh-CN）。
 *
 * 之前为避免"导航英文 + 页面中文"混搭，全站硬锁 zh-CN。现在恢复多语言基础设施：
 *   - 启动语言：localStorage 持久化优先 → 浏览器语言 → 默认 zh-CN
 *   - 切换语言：useLanguage().setLanguage(...) 会同时写 localStorage 并触发 re-render
 *   - 默认仍是 zh-CN，且 en/vi 资源已就位 —— 中文用户不会有任何视觉回归
 *
 * 注意：不要加 supportedLngs + nonExplicitSupportedLngs —— 二者会把 'zh-CN' 归一到 'zh'
 * 去查 resource（resource 是按 'zh-CN' 存的），导致 t() 找不到 key、直接吐出原始 key。
 *
 * 用法：
 *   import { useTranslation } from 'react-i18next';
 *   const { t } = useTranslation();
 *   <button>{t('nav.login')}</button>
 *
 *   // 放语言切换器（另一 agent 会在 header 里用）：
 *   import { useLanguage, SUPPORTED_LANGUAGES } from '../i18n';
 *   const { language, setLanguage } = useLanguage();
 *
 * 翻译完整性：页面文案目前以中文为主，en/vi 仅 nav/common 等基础键已译。
 * 这里只做"基础设施可用 + 默认中文不回归"，全量翻译不在本批范围。
 */
import { useCallback, useSyncExternalStore } from 'react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './locales/zh-CN.json';
import en from './locales/en.json';
import vi from './locales/vi.json';

export const SUPPORTED_LANGUAGES = ['zh-CN', 'en', 'vi'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const DEFAULT_LANGUAGE: SupportedLanguage = 'zh-CN';
const STORAGE_KEY = 'app.lang';

/** 把任意 BCP-47 标签归一到我们支持的三种之一（zh* → zh-CN；en* → en；vi* → vi）。 */
function normalizeLanguage(raw: string | null | undefined): SupportedLanguage | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-CN';
  if (lower.startsWith('en')) return 'en';
  if (lower.startsWith('vi')) return 'vi';
  return null;
}

/**
 * 启动语言：仅 localStorage（用户显式选择过的语言）→ 否则默认 zh-CN。
 * 不做浏览器语言探测：客户群以中文为主，且页面文案目前以中文为主、en/vi 仅
 * 基础键已译；若按浏览器语言（如英文环境）自动切换会出现"导航英文 + 页面中文"
 * 的混搭回归（见历史任务"强制中文默认"）。用户可在页头切换器主动切换，会被持久化。
 */
function detectInitialLanguage(): SupportedLanguage {
  if (typeof window === 'undefined') return DEFAULT_LANGUAGE;
  try {
    const stored = normalizeLanguage(window.localStorage.getItem(STORAGE_KEY));
    if (stored) return stored;
  } catch {
    /* localStorage 不可用（隐私模式等）—— 降级到默认中文 */
  }
  return DEFAULT_LANGUAGE;
}

// 导出 init promise —— main.tsx 等它 resolve 后再渲染，
// 保证首屏 i18n 已 ready，否则 t() 会输出原始 key（nav.flights 字面量）。
export const i18nReady = i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    en: { translation: en },
    vi: { translation: vi },
  },
  lng: detectInitialLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: { escapeValue: false }, // React 已经 escape，不重复
  react: { useSuspense: false },
});

/** 切换语言并持久化到 localStorage（供 header 切换器调用）。 */
export function setLanguage(lang: SupportedLanguage): void {
  void i18n.changeLanguage(lang);
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* 持久化失败不致命：当前会话仍已切换 */
  }
}

/**
 * 轻量语言状态 hook —— 订阅 i18next 的 languageChanged 事件，返回当前语言 + setter。
 * 用 useSyncExternalStore 保证切换时组件正确 re-render（不引第三方状态库）。
 */
export function useLanguage(): {
  language: SupportedLanguage;
  setLanguage: (lang: SupportedLanguage) => void;
} {
  const subscribe = useCallback((onChange: () => void) => {
    i18n.on('languageChanged', onChange);
    return () => i18n.off('languageChanged', onChange);
  }, []);
  const getSnapshot = useCallback(
    () => normalizeLanguage(i18n.language) ?? DEFAULT_LANGUAGE,
    [],
  );
  const language = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_LANGUAGE);
  return { language, setLanguage };
}

export default i18n;
