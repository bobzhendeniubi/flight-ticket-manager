/**
 * 按需加载失败（懒加载页面的代码文件没拿到）的识别，与「自动刷新一次」的防循环记号。
 *
 * 背景：运营后台按路由拆包后，每个页面是一个带内容哈希的独立文件。发版会整体替换前端容器，
 * 旧哈希文件随即 404——发版前就开着的标签页，再点进一个还没加载过的菜单，浏览器就报
 * 「Failed to fetch dynamically imported module」。刷新一次拿到新版 index.html（新文件名）就好。
 * 内地↔香港链路抖动导致的下载失败，症状与处置一样（刷新重来），走同一套。
 *
 * 口径：
 *   · 第一次失败 → 自动刷新；刷新前先在 sessionStorage 记下「这个构建为此刷新过」（先记后刷，防死循环）；
 *   · 刷新后同一构建仍失败 → 不再自动刷新，由页面显示「系统已更新，请刷新」提示，交给用户；
 *   · 之后只要有页面代码成功加载过，说明刷新已把页面救回来，清掉记号——下一次发版还能再自动刷新一次。
 *
 * 这里只放纯逻辑（存储可注入，便于单测）；React 侧见 components/LazyPage.tsx。
 */

/** sessionStorage 键：值为「已经为 chunk 加载失败自动刷新过」的构建号。 */
export const CHUNK_RELOAD_STORAGE_KEY = 'ftm.chunkReload.buildId';

/** 防循环记号用到的存储能力（默认 sessionStorage：只在本标签页内有效，刷新后仍在）。 */
export type ReloadGuardStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * 各浏览器对「动态 import 的文件没拿到」的措辞不同，统一按报错文本识别：
 * 文件 404、被 SPA 回退成 index.html（MIME 不对）、网络中断，最终都落到这几句。
 */
const CHUNK_LOAD_ERROR_PATTERNS: readonly RegExp[] = [
  /Failed to fetch dynamically imported module/i, // Chrome / Edge
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari
  /Unable to preload CSS/i, // Vite 预加载页面依赖的 CSS 失败
  /Loading (?:CSS )?chunk \S+ failed/i, // webpack 风格措辞（兜底）
];

/** 是不是「页面代码文件没拿到」这一类错误（区别于页面代码自身的 bug）。 */
export function isChunkLoadError(error: unknown): boolean {
  if (typeof error === 'string') return CHUNK_LOAD_ERROR_PATTERNS.some((re) => re.test(error));
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === 'ChunkLoadError') return true;
  return typeof message === 'string' && CHUNK_LOAD_ERROR_PATTERNS.some((re) => re.test(message));
}

function sessionStorageOrNull(): ReloadGuardStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    // 部分隐私模式 / 禁用站点数据时，连访问 sessionStorage 本身都会抛
    return null;
  }
}

/**
 * 申请一次自动刷新。
 * 本构建还没为此刷新过 → 记下构建号并返回 true，调用方随即刷新；
 * 已经刷过（刷新后仍失败）、或存储不可用（没法防循环）→ 返回 false，调用方改为提示用户手动刷新。
 */
export function claimChunkReload(
  buildId: string,
  storage: ReloadGuardStorage | null = sessionStorageOrNull(),
): boolean {
  if (!storage) return false;
  try {
    if (storage.getItem(CHUNK_RELOAD_STORAGE_KEY) === buildId) return false;
    storage.setItem(CHUNK_RELOAD_STORAGE_KEY, buildId);
    // 读回确认真记上了：个别环境 setItem 静默失败，记不上就不刷，宁可提示也不冒循环的险
    return storage.getItem(CHUNK_RELOAD_STORAGE_KEY) === buildId;
  } catch {
    return false;
  }
}

/** 页面代码成功加载过：清掉记号，下一次（比如又一次发版）遇到失败还能自动刷新一次。 */
export function releaseChunkReload(storage: ReloadGuardStorage | null = sessionStorageOrNull()): void {
  try {
    storage?.removeItem(CHUNK_RELOAD_STORAGE_KEY);
  } catch {
    // 清不掉只意味着下次少一次自动刷新（改为提示），不影响使用
  }
}
