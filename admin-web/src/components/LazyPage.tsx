import { lazy, Suspense, type ComponentType, type ReactElement } from 'react';
import { claimChunkReload, isChunkLoadError, releaseChunkReload } from '../lib/chunkLoadRecovery';

/**
 * 路由页面懒加载：每个页面拆成独立的代码文件，第一次点进去才下载；首屏只下外壳 + 当前页面。
 *
 * 发版后旧文件失效的处理（口径见 lib/chunkLoadRecovery）：
 *   · 页面代码没拿到 → 自动刷新一次，刷新发出后保持「加载中」直到页面被替换；
 *   · 刷新后仍失败 → 在页面位置显示「系统已更新，请刷新」+ 刷新按钮，不再自动刷；
 *   · 页面代码自身的错误（真 bug）不在这里吞，照常抛给 Layout 外层的 ErrorBoundary。
 * 全局的「新版本已发布」横幅仍只有 BuildVersionBanner 一条，这里不另起横幅。
 */

/** 自动刷新已发出、页面却迟迟没被替换（被离开确认框拦下 / 网络极慢）时，最多等这么久就改显提示。 */
const RELOAD_GRACE_MS = 10_000;
/** 预取先等当前页面把自己的数据请求跑完，再趁空闲下载别的页面，别跟首屏抢带宽。 */
const PREFETCH_DELAY_MS = 3_000;
/** requestIdleCallback 的兜底超时：一直忙也最多再等这么久就预取。 */
const PREFETCH_IDLE_TIMEOUT_MS = 5_000;

type PageModule = { default: ComponentType };

export interface LazyPageComponent {
  (): ReactElement;
  /** 预先下载页面代码（登录后 / 空闲时调用）。失败静默——真正进入页面时再走失败处理。 */
  preload: () => void;
}

/** 与各页面自己的「加载中」同款；延迟淡入，缓存命中的瞬时加载不会闪一下。 */
function PageLoading() {
  return (
    <div
      role="status"
      className="flex animate-fade-in items-center gap-2 py-12 text-sm text-ink-muted"
      style={{ animationDelay: '150ms' }}
    >
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      加载中…
    </div>
  );
}

/** 自动刷新用过一次仍拿不到页面代码时，占住页面位置的提示（配色同 BuildVersionBanner）。 */
function ChunkUpdateNotice() {
  return (
    <div role="alert" className="card border-amber-200 bg-amber-50">
      <h2 className="text-base font-semibold text-amber-800">系统已更新，请刷新页面</h2>
      <p className="mt-1 text-sm text-amber-700">
        这个页面的程序文件已随新版本替换（网络不稳定时也会出现这个提示），刷新后即可继续使用。
      </p>
      <div className="mt-3">
        <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
          刷新页面
        </button>
      </div>
    </div>
  );
}

function recoverFromChunkError(error: unknown): Promise<PageModule> {
  if (!isChunkLoadError(error)) return Promise.reject(error);
  console.warn('[LazyPage] 页面代码加载失败', error);
  if (claimChunkReload(__APP_BUILD_ID__)) {
    window.location.reload();
    return new Promise((resolve) => {
      window.setTimeout(() => resolve({ default: ChunkUpdateNotice }), RELOAD_GRACE_MS);
    });
  }
  return Promise.resolve({ default: ChunkUpdateNotice });
}

/**
 * 把一个页面组件包成按需加载的路由元素。loader 形如
 * `() => import('./pages/OrdersPage').then((m) => m.OrdersPage)`（页面是具名导出）。
 */
export function lazyPage(loader: () => Promise<ComponentType>): LazyPageComponent {
  let pending: Promise<ComponentType> | null = null;
  let loaded: ComponentType | null = null;

  // 路由渲染与预取共用同一次下载；失败清掉缓存，允许之后重试。
  const load = (): Promise<ComponentType> => {
    pending ??= loader().then(
      (component) => {
        loaded = component;
        return component;
      },
      (error: unknown) => {
        pending = null;
        throw error;
      },
    );
    return pending;
  };

  const LazyComponent = lazy(() =>
    load().then((component): PageModule => {
      // 用户实际打开的页面加载成功，说明（如有）上次自动刷新已把页面救回来，清掉防循环记号。
      // 后台预取成功不算：否则停在「系统已更新」提示上时，预取一成功就清掉记号，再手动刷新会多刷一轮。
      releaseChunkReload();
      return { default: component };
    }, recoverFromChunkError),
  );

  function LazyPage(): ReactElement {
    // 已下载过（预取命中 / 再次进入）就直接渲染，不经 Suspense，免得闪一下「加载中」
    const Page = loaded;
    return <Suspense fallback={<PageLoading />}>{Page ? <Page /> : <LazyComponent />}</Suspense>;
  }

  return Object.assign(LazyPage, {
    preload: () => {
      load().catch(() => undefined);
    },
  });
}

/**
 * 延后到浏览器空闲时执行（预取页面代码用），返回取消函数。
 * Safari 没有 requestIdleCallback，退化为单纯延时。
 */
export function whenIdle(task: () => void, delayMs: number = PREFETCH_DELAY_MS): () => void {
  let idleHandle: number | null = null;
  const timer = window.setTimeout(() => {
    if (typeof window.requestIdleCallback === 'function') {
      idleHandle = window.requestIdleCallback(() => task(), { timeout: PREFETCH_IDLE_TIMEOUT_MS });
    } else {
      task();
    }
  }, delayMs);
  return () => {
    window.clearTimeout(timer);
    if (idleHandle !== null) window.cancelIdleCallback(idleHandle);
  };
}
