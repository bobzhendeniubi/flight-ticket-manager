import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Seo } from '../components/Seo';
import { EmptyState } from '../components/EmptyState';

/**
 * 404 页（完整实现）。
 * 友好空状态 + 回首页/帮助中心入口；Seo 标题 + robots noindex（不进搜索索引）。
 * Seo 组件本身不带 noindex prop（共享组件不改），故这里额外渲染一个 Helmet 注入 robots。
 */
export default function NotFoundPage() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-3xl flex-col items-center justify-center px-4 py-12">
      <Seo title="页面不存在" description="抱歉，你访问的页面不存在或已下线。" />
      {/* 404 不应被搜索引擎索引 */}
      <Helmet>
        <meta name="robots" content="noindex, follow" />
      </Helmet>
      <EmptyState
        icon="search"
        title="页面走丢了"
        hint="你访问的页面不存在或已下线。试试回到首页，或去帮助中心找找答案。"
        action={
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              to="/"
              className="inline-flex items-center justify-center rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white shadow-card transition hover:brightness-105 active:scale-[0.98]"
            >
              回到首页
            </Link>
            <Link
              to="/help"
              className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-surface px-5 py-2.5 text-sm font-semibold text-ink transition hover:bg-brand-50 active:scale-[0.98]"
            >
              帮助中心
            </Link>
          </div>
        }
      />
    </main>
  );
}
