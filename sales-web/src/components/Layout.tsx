import { Suspense, lazy, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, NavLink, Outlet, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../stores/auth';
import { useCart } from '../stores/cart';
import { useLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from '../i18n';
import { MobilePreviewFrame } from './MobilePreviewFrame';
import { MobileBottomBar } from './MobileBottomBar';
import { Icon } from './Icon';
import { WaveDivider } from './WaveDivider';

// 浮动 AI 助手懒加载（G1 性能）：AiAssistant 体量大（~40KB），不该进首屏 bundle。
// React.lazy + Suspense(fallback=null) 让它在外壳挂载后异步拉取 —— 行为与之前完全一致
// （仍渲染同一个浮动入口），只是把它从初始 chunk 里挪走，缩小首屏 JS。
const AiAssistant = lazy(() =>
  import('./AiAssistant').then((m) => ({ default: m.AiAssistant })),
);

const ROLE_LABEL: Record<string, string> = {
  CUSTOMER: '客户',
  AGENT: '代理',
  STAFF: '运营',
  ADMIN: '管理员',
};

// 管理后台已拆分到 admin-web (:5174)。前台不再展示后台入口。
// /admin/* 路由仍保留可访问（向后兼容旧链接），但不在 nav 中显示。

// 桌面端导航 pill：激活态用 brand-50 底 + brand-700 字（平滑高亮），默认态柔和悬停
const navPill = (isActive: boolean) =>
  `rounded-xl px-3.5 py-1.5 font-semibold transition-all duration-200 ${
    isActive
      ? 'bg-brand-50 text-brand-700 shadow-sm'
      : 'text-ink-soft hover:bg-brand-50/60 hover:text-brand-700'
  }`;

// 手机抽屉导航项：同一套激活语义，纵向块状
const drawerItem = (isActive: boolean) =>
  `block rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors ${
    isActive ? 'bg-brand-50 text-brand-700' : 'text-ink-soft hover:bg-brand-50/60 hover:text-brand-700'
  }`;

export function Layout() {
  const { t } = useTranslation();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // 主导航：用 t() 而不是硬编码文字
  // 排序按运营确认：套餐是主推，排第一（套餐-机票-酒店-用车-签证）
  const frontNav = [
    { to: '/', label: t('nav.bundles'), exact: true },
    { to: '/flights', label: t('nav.flights') },
    { to: '/hotels', label: t('nav.hotels') },
    { to: '/transfers', label: t('nav.transfers') },
    { to: '/visas', label: t('nav.visas') },
  ];

  const isAgent = user?.role === 'AGENT';
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'STAFF';

  // ?preview=mobile → 把页面包进 375×812 的手机壳，模拟小程序 UI
  // 在电脑浏览器里开演示 / 录屏 / 给客户展示效果时很方便
  const mobilePreview = searchParams.get('preview') === 'mobile';
  if (mobilePreview) {
    return <MobilePreviewFrame />;
  }

  // 手机端汉堡菜单展开状态
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const closeMenu = () => setMobileMenuOpen(false);

  return (
    <div className="relative min-h-screen flex flex-col bg-canvasWarm">
      {/* 顶部柔和天幕（lagoon-light → 透明）+ 极淡颗粒：给整站一层海岛暖空气，
          固定在视口顶部、pointer-events-none，不影响任何交互 / 布局。 */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 z-0 h-64"
        style={{
          backgroundImage:
            'linear-gradient(180deg, rgba(234,250,255,0.9) 0%, rgba(234,250,255,0.45) 38%, rgba(251,246,238,0) 100%)',
        }}
      />
      <div aria-hidden className="grain pointer-events-none fixed inset-0 z-0" />

      {/* 顶部：品牌 + 前台导航 + 用户菜单 */}
      <header className="glass-header sticky top-0 z-40">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-2 px-3 py-2.5 md:gap-5 md:px-4 md:py-3">
          {/* 手机端：左侧汉堡按钮 */}
          <button
            type="button"
            className="md:hidden flex h-9 w-9 items-center justify-center rounded-xl border border-ink/10 bg-white/70 text-ink-soft shadow-card transition-all duration-200 hover:border-brand/40 hover:bg-brand-50/60 hover:text-brand-700 active:scale-95"
            onClick={() => setMobileMenuOpen(true)}
            aria-label={t('nav.menu')}
          >
            <Icon name="menu" className="h-5 w-5" />
          </button>

          <Link to="/" className="group flex items-center gap-2.5 truncate" aria-label="椰岛假期 Coco Holiday">
            {/* 椰岛日轮标记：lagoon→brand 渐变底 + 暖金小太阳叠角，呼应海岛美学 */}
            <span
              aria-hidden
              className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-2xl text-white shadow-lift transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:rotate-3"
              style={{ backgroundImage: 'linear-gradient(135deg, #19b8c9 0%, #0e8aa0 60%, #0a6e80 100%)' }}
            >
              <span
                className="absolute -right-1.5 -top-1.5 h-5 w-5 rounded-full"
                style={{ background: 'radial-gradient(circle at 40% 40%, #ffe8b4, #ffc86e 70%)' }}
              />
              <Icon name="plane" className="relative h-5 w-5" />
            </span>
            <span className="flex flex-col leading-none">
              <span className="text-base md:text-lg font-extrabold tracking-tight text-ink transition-colors group-hover:text-brand-700">椰岛假期</span>
              <span className="text-display hidden md:block mt-0.5 text-[11px] font-medium uppercase tracking-[0.22em] text-brand-700/80">Coco Holiday</span>
            </span>
          </Link>

          {/* 桌面端：主导航 */}
          <nav className="hidden md:flex items-center gap-1 text-sm">
            {frontNav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.exact}
                className={({ isActive }) => navPill(isActive)}
              >
                {n.label}
              </NavLink>
            ))}
            {isAgent && (
              <>
                <NavLink to="/team" className={({ isActive }) => navPill(isActive)}>
                  {t('nav.team')}
                </NavLink>
                <NavLink to="/my-commissions" className={({ isActive }) => navPill(isActive)}>
                  {t('nav.commissions')}
                </NavLink>
              </>
            )}
          </nav>

          {/* 桌面端：全局搜索（C2）—— 一框直达 /search?q= */}
          <GlobalSearch className="hidden lg:flex" />

          {/* 右侧用户菜单：手机端只保留搜索图标 + 购物车，其他进汉堡 */}
          <nav className="flex items-center gap-2 md:gap-2.5 text-sm">
            {/* 手机端 / 中屏：搜索改为图标，点开展开成搜索条（C2 紧凑形态） */}
            <MobileSearchToggle />
            <a
              href="/?preview=mobile"
              className="chip hidden md:inline-flex items-center gap-1.5 transition-colors hover:bg-brand-50 hover:text-brand-700"
              title="以移动端视口预览（小程序端测试）"
            >
              <Icon name="phone" className="h-3.5 w-3.5" />
              {t('nav.miniprogramPreview')}
            </a>
            {/* 桌面端：语言切换（zh 默认） */}
            <LanguageSwitch className="hidden md:flex" />
            <CartButton />
            {/* 桌面端：完整用户区 */}
            {user ? (
              <div className="hidden md:flex items-center gap-2">
                <span className="mx-1 h-5 w-px bg-ink/10" aria-hidden />
                <Link to="/orders" className="rounded-xl px-3 py-1.5 font-semibold text-ink-soft transition-all duration-200 hover:bg-brand-50/60 hover:text-brand-700">
                  {t('nav.myOrders')}
                </Link>
                <Link
                  to="/me"
                  className="flex items-center gap-2 rounded-xl py-1 pl-1 pr-2 text-ink-soft transition-all duration-200 hover:bg-brand-50/60 hover:text-brand-700"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-brand-100 to-brand-50 text-xs font-bold text-brand-700 ring-1 ring-brand-100">
                    {(user.displayName ?? user.email ?? '').slice(0, 1).toUpperCase()}
                  </span>
                  <span className="max-w-[9rem] truncate font-semibold">{user.displayName ?? user.email}</span>
                  <span className="badge-soft">
                    {ROLE_LABEL[user.role] ?? user.role}
                  </span>
                </Link>
                <button
                  type="button"
                  className="btn-secondary text-sm py-1.5"
                  onClick={async () => {
                    await logout();
                    navigate('/');
                  }}
                >
                  {t('nav.logout')}
                </button>
              </div>
            ) : (
              <div className="hidden md:flex items-center gap-3">
                <Link to="/login" className="btn-primary text-sm py-1.5">
                  {t('nav.login')}
                </Link>
              </div>
            )}
          </nav>
        </div>

        {/* 手机端：汉堡菜单抽屉 */}
        {mobileMenuOpen && (
          <div className="md:hidden fixed inset-0 z-50 bg-ink/40 backdrop-blur-sm animate-fade-in" onClick={closeMenu}>
            <div
              className="absolute left-0 top-0 h-full w-72 max-w-[82vw] bg-surface shadow-pop flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-ink/10 px-4 py-3.5">
                <span className="flex items-center gap-2 font-extrabold text-ink">
                  <span
                    aria-hidden
                    className="flex h-7 w-7 items-center justify-center rounded-xl text-white shadow-card"
                    style={{ backgroundImage: 'linear-gradient(135deg, #2fb6cb 0%, #0e8aa0 60%, #0a6e80 100%)' }}
                  >
                    <Icon name="plane" className="h-4 w-4" />
                  </span>
                  椰岛假期
                </span>
                <button
                  onClick={closeMenu}
                  className="flex h-8 w-8 items-center justify-center rounded-xl text-ink-muted transition-colors hover:bg-brand-50/60 hover:text-brand-700 text-xl"
                  aria-label="关闭"
                >
                  ×
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-2 py-3">
                {/* 抽屉内全局搜索（C2 手机端形态） */}
                <div className="px-1 pb-2">
                  <GlobalSearch onSubmitted={closeMenu} />
                </div>

                {/* 主导航 */}
                {frontNav.map((n) => (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    end={n.exact}
                    onClick={closeMenu}
                    className={({ isActive }) => drawerItem(isActive)}
                  >
                    {n.label}
                  </NavLink>
                ))}
                {isAgent && (
                  <>
                    <NavLink to="/team" onClick={closeMenu} className={({ isActive }) => drawerItem(isActive)}>
                      {t('nav.team')}
                    </NavLink>
                    <NavLink to="/my-commissions" onClick={closeMenu} className={({ isActive }) => drawerItem(isActive)}>
                      {t('nav.commissions')}
                    </NavLink>
                  </>
                )}

                <div className="my-2.5 border-t border-ink/10" />

                {/* 服务入口：查订单 / 帮助（非会员也常用） */}
                <Link to="/lookup" onClick={closeMenu} className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-ink-soft transition-colors hover:bg-brand-50/60 hover:text-brand-700">
                  <Icon name="search" className="h-4 w-4 text-ink-muted" />
                  查订单
                </Link>
                <Link to="/help" onClick={closeMenu} className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-ink-soft transition-colors hover:bg-brand-50/60 hover:text-brand-700">
                  <Icon name="support" className="h-4 w-4 text-ink-muted" />
                  帮助中心
                </Link>

                {/* 语言切换（zh 默认） */}
                <div className="px-3 pt-2 pb-1">
                  <span className="mb-1.5 block text-xs font-semibold text-ink-muted">{t('language.label')}</span>
                  <LanguageSwitch />
                </div>

                <div className="my-2.5 border-t border-ink/10" />

                {/* 用户区 */}
                {user ? (
                  <>
                    <Link to="/orders" onClick={closeMenu} className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-ink-soft transition-colors hover:bg-brand-50/60 hover:text-brand-700">
                      <Icon name="ticket" className="h-4 w-4 text-ink-muted" />
                      {t('nav.myOrders')}
                    </Link>
                    <Link to="/me" onClick={closeMenu} className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-ink-soft transition-colors hover:bg-brand-50/60 hover:text-brand-700">
                      <Icon name="user" className="h-4 w-4 text-ink-muted" />
                      <span>{user.displayName ?? user.email}</span>
                      <span className="badge-soft">
                        {ROLE_LABEL[user.role] ?? user.role}
                      </span>
                    </Link>
                    <button
                      type="button"
                      className="w-full text-left block rounded-xl px-3 py-2.5 text-sm font-semibold text-deal transition-colors hover:bg-deal-light"
                      onClick={async () => {
                        closeMenu();
                        await logout();
                        navigate('/');
                      }}
                    >
                      {t('nav.logout')}
                    </button>
                  </>
                ) : (
                  <Link to="/login" onClick={closeMenu} className="mt-1 block">
                    <span className="btn-primary w-full text-sm">{t('nav.login')}</span>
                  </Link>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 管理员登录在前台时，显示提示去后台 */}
        {isAdmin && (
          <div className="border-t border-sun/25 bg-sun-light">
            <div className="mx-auto max-w-7xl px-4 py-2 text-xs text-amber-800 flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1.5">
                <Icon name="info" className="h-3.5 w-3.5 shrink-0" />
                您是管理员/运营，前台仅供浏览。后台操作请到{' '}
                <a href="http://localhost:5174" className="font-semibold underline decoration-sun underline-offset-2 transition-colors hover:text-amber-900" target="_blank" rel="noreferrer">
                  http://localhost:5174
                </a>
              </span>
              <a href="http://localhost:5174" target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-sun px-2.5 py-1 font-semibold text-white shadow-card transition-all duration-200 hover:brightness-105 hover:-translate-y-px active:scale-95">
                进入后台 <Icon name="arrowRight" className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
        )}
      </header>

      <main className="relative z-10 flex-1">
        {/* 手机端底部留出 bottom bar 高度 + 页面操作条，避免内容被挡住 */}
        <div className="mx-auto w-full max-w-7xl px-4 pt-8 pb-32 md:pb-8">
          <Outlet />
        </div>
      </main>

      <SiteFooter />

      {/* 手机端底部导航：首页 / 套餐 / 购物车（带数量）/ 我的 */}
      <MobileBottomBar />

      <AddToCartToast />

      {/* 浮动 AI 助手 — 任何角色都看得到（admin 也能测试 demo）；下单时才跳登录。
          懒加载：fallback=null，加载完成前不占位（浮动入口出现得略晚，可接受）。 */}
      <Suspense fallback={null}>
        <AiAssistant />
      </Suspense>
    </div>
  );
}

/** 全局搜索框（C2）— 提交后跳 /search?q=<encoded>。
 *  桌面端 inline 用在顶栏；手机端用在抽屉里（onSubmitted 关抽屉）。 */
function GlobalSearch({
  className,
  onSubmitted,
}: {
  className?: string;
  onSubmitted?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [q, setQ] = useState('');

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const keyword = q.trim();
    if (!keyword) return;
    navigate(`/search?q=${encodeURIComponent(keyword)}`);
    setQ('');
    onSubmitted?.();
  };

  return (
    <form
      role="search"
      onSubmit={onSubmit}
      className={`relative items-center ${className ?? 'flex'}`}
    >
      <Icon
        name="search"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
      />
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜套餐 / 机票 / 酒店 / 目的地"
        aria-label={t('common.search')}
        className="input w-full py-2 pl-9 pr-3 lg:w-64"
        enterKeyHint="search"
      />
    </form>
  );
}

/** 手机 / 中屏：搜索图标 → 点开展开成顶栏下方的搜索条（C2 紧凑形态）。 */
function MobileSearchToggle() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="lg:hidden flex h-9 w-9 items-center justify-center rounded-xl border border-ink/10 bg-white/70 text-ink-soft shadow-card transition-all duration-200 hover:border-brand/40 hover:bg-brand-50/60 hover:text-brand-700 active:scale-95"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('common.search')}
        aria-expanded={open}
      >
        <Icon name="search" className="h-5 w-5" />
      </button>
      {open && (
        <div className="lg:hidden absolute inset-x-0 top-full z-40 border-b border-slate-200/70 bg-surface/95 px-3 py-2.5 shadow-card backdrop-blur-xl animate-fade-in">
          <GlobalSearch onSubmitted={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}

/** 语言切换（zh/en/vi）— 用 useLanguage()，zh 为默认。
 *  小巧分段控件，避免新增依赖；切换即时持久化到 localStorage（i18n 内部处理）。 */
function LanguageSwitch({ className }: { className?: string }) {
  const { language, setLanguage } = useLanguage();
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t('language.label')}
      className={`items-center gap-0.5 rounded-xl border border-slate-200 bg-white/70 p-0.5 text-xs ${className ?? 'flex'}`}
    >
      {SUPPORTED_LANGUAGES.map((lng: SupportedLanguage) => {
        const active = language === lng;
        const short = lng === 'zh-CN' ? '中' : lng === 'en' ? 'EN' : 'VI';
        return (
          <button
            key={lng}
            type="button"
            onClick={() => setLanguage(lng)}
            aria-pressed={active}
            title={t(`language.${lng}`)}
            className={`rounded-lg px-2 py-1 font-semibold transition-colors ${
              active
                ? 'bg-brand-50 text-brand-700 shadow-sm'
                : 'text-ink-muted hover:bg-brand-50/60 hover:text-brand-700'
            }`}
          >
            {short}
          </button>
        );
      })}
    </div>
  );
}

/** 多列页脚（E1）— 关于椰岛假期 / 帮助支持 / 法律条款 / 联系我们 + 品牌简介 + 社交 + 底部法律行。
 *  链接全用 react-router <Link>；手机端列堆叠，并留出底部导航高度（pb-24）。 */
function SiteFooter() {
  const year = new Date().getFullYear();

  // 占位公司信息：真实主体名称与 ICP 备案号待法务/运营补全 —— 这里明确标注 placeholder。
  const COMPANY_NAME = '椰岛假期'; // 页脚展示品牌名（公司主体名称按要求不对外展示）
  const ICP = 'ICP 备案号：待补（placeholder）';

  const columns: Array<{
    title: string;
    links: Array<{ label: string; to: string }>;
  }> = [
    {
      title: '关于椰岛假期',
      links: [
        { label: '关于我们', to: '/about' },
        { label: '为什么选我们', to: '/about' },
        { label: '海岛套餐', to: '/' },
        { label: '机票', to: '/flights' },
      ],
    },
    {
      title: '帮助支持',
      links: [
        { label: '帮助中心', to: '/help' },
        { label: '查询订单', to: '/lookup' },
        { label: '我的订单', to: '/orders' },
        { label: '购物车', to: '/cart' },
      ],
    },
    {
      title: '产品服务',
      links: [
        { label: '酒店', to: '/hotels' },
        { label: '地面服务', to: '/transfers' },
        { label: '签证', to: '/visas' },
        { label: '套餐', to: '/' },
      ],
    },
    {
      title: '联系我们',
      links: [
        { label: '联系方式', to: '/contact' },
        { label: '在线咨询', to: '/contact' },
        { label: '帮助中心', to: '/help' },
        { label: '查询订单', to: '/lookup' },
      ],
    },
  ];

  return (
    <footer className="relative z-10 mt-8 text-sm text-ink-soft">
      {/* 顶部漂移波浪（翻转贴顶，波峰朝上"托住"页脚）—— 与 hero 底波呼应，标志性海岛母题。
          色值 = 页脚暖沙底，让波浪与页脚无缝融合（波之上是页面暖底）。 */}
      <div className="relative h-11" aria-hidden>
        <WaveDivider fill="#f6ecdb" height={44} flip position="top" />
      </div>
      <div
        className="border-t border-sand"
        style={{ backgroundImage: 'linear-gradient(180deg, #f6ecdb 0%, #fbf4e9 100%)' }}
      >
      <div className="mx-auto max-w-7xl px-4 py-10">
        <div className="grid gap-8 md:grid-cols-12">
          {/* 品牌简介 + 社交 */}
          <div className="md:col-span-4">
            <Link to="/" className="inline-flex items-center gap-2.5" aria-label="椰岛假期">
              <span
                aria-hidden
                className="flex h-9 w-9 items-center justify-center rounded-2xl text-white shadow-card"
                style={{ backgroundImage: 'linear-gradient(135deg, #2fb6cb 0%, #0e8aa0 60%, #0a6e80 100%)' }}
              >
                <Icon name="plane" className="h-5 w-5" />
              </span>
              <span className="flex flex-col leading-none">
                <span className="text-base font-extrabold tracking-tight text-ink">椰岛假期</span>
                <span className="mt-0.5 text-[11px] font-medium text-ink-muted">Coco Holiday</span>
              </span>
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-ink-soft">
              澳门⇌岘港海岛专线，机票 + 酒店 + 签证 + 地面服务一价全包。中文客服全程在线，让海岛度假省心又省钱。
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="badge-soft">
                <Icon name="shield" className="h-3.5 w-3.5" />
                正规旅行社
              </span>
              <span className="badge-soft">
                <Icon name="support" className="h-3.5 w-3.5" />
                7×12 客服
              </span>
            </div>
          </div>

          {/* 链接列 */}
          <nav aria-label="页脚导航" className="md:col-span-8">
            <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
              {columns.map((col) => (
                <div key={col.title}>
                  <h3 className="text-sm font-bold text-ink">{col.title}</h3>
                  <ul className="mt-3 space-y-2.5">
                    {col.links.map((link, idx) => (
                      <li key={`${link.label}-${idx}`}>
                        <Link
                          to={link.to}
                          className="text-sm text-ink-soft transition-colors hover:text-brand-700 hover:underline"
                        >
                          {link.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </nav>
        </div>

        {/* 底部法律行 — 公司名称占位 + ICP 占位 + © */}
        <div className="mt-10 flex flex-col gap-2 border-t border-slate-200/70 pt-6 text-xs text-ink-muted sm:flex-row sm:items-center sm:justify-between">
          <span>
            © {year} {COMPANY_NAME} · 保留所有权利
          </span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{ICP}</span>
            <span aria-hidden className="hidden sm:inline text-ink/20">·</span>
            <Link to="/help" className="transition-colors hover:text-brand-700">服务条款（待补）</Link>
            <Link to="/help" className="transition-colors hover:text-brand-700">隐私政策（待补）</Link>
          </span>
        </div>
      </div>

      {/* 手机端底部导航占位高度，避免最后一行被 bottom bar 挡住 */}
      <div className="h-20 md:hidden" aria-hidden />
      </div>
    </footer>
  );
}

/** 顶部购物车按钮 — 显示数量徽章，链到 /cart。
 *  手机端隐藏（入口在 MobileBottomBar，拇指可达），桌面端保留。 */
function CartButton() {
  const count = useCart((s) => s.items.reduce((sum, i) => sum + i.qty, 0));
  return (
    <Link
      to="/cart"
      className="relative hidden md:inline-flex items-center gap-1.5 rounded-xl border border-slate-200/70 bg-white/70 px-3 py-1.5 font-semibold text-ink-soft shadow-card transition-all duration-200 hover:border-brand/40 hover:bg-brand-50/60 hover:text-brand-700 active:scale-95"
    >
      <Icon name="cart" className="h-4 w-4" />
      <span className="hidden md:inline">购物车</span>
      {count > 0 && (
        <span className="absolute -top-1.5 -right-1.5 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-deal px-1 text-[11px] font-bold text-white shadow-deal nums">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  );
}

/** 加入购物车的飘字提示（监听 ftm-cart-add 事件） */
function AddToCartToast() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent<{ name: string }>).detail;
      if (detail?.name) {
        setMsg(`已加入购物车：${detail.name}`);
        setTimeout(() => setMsg(null), 1800);
      }
    };
    window.addEventListener('ftm-cart-add', onAdd);
    return () => window.removeEventListener('ftm-cart-add', onAdd);
  }, []);
  if (!msg) return null;
  return (
    // 手机端抬高到 bottom bar 之上
    <div className="fixed bottom-20 right-4 md:bottom-6 md:right-6 z-50 inline-flex items-center gap-1.5 rounded-2xl bg-ink px-4 py-2.5 text-sm font-semibold text-white shadow-pop animate-fade-up">
      <Icon name="check" className="h-4 w-4 text-emerald-300" />
      {msg}
    </div>
  );
}
