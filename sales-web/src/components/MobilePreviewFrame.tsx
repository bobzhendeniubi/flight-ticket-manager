/**
 * 手机壳预览 —— 把 sales-web 当做"小程序客户端"在桌面浏览器上演示。
 *
 * URL 触发：?preview=mobile
 *   例：http://localhost:5173/?preview=mobile
 *   例：http://localhost:5173/cart?preview=mobile
 *
 * 实现思路：在 iframe 里嵌自己（去掉 ?preview=mobile，用正常布局渲染），
 * 外层画一个 375×812 (iPhone 14 Pro 视口) 的手机壳。
 *
 * 为什么用 iframe？因为 sales-web 本身已经响应式适配 ——
 * 直接把 viewport 缩到 375px 就能看到移动端布局，无需重写任何页面。
 * 这也是"小程序测试" = 客户端 mobile 版的实现方式。
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

const DEVICE = { width: 390, height: 844, bezel: 12, notch: 30 }; // iPhone 14 Pro-ish

export function MobilePreviewFrame() {
  const location = useLocation();
  const [reloadKey, setReloadKey] = useState(0);

  // 内嵌 URL：当前路径 + 去掉 preview 参数
  const embedUrl = useMemo(() => {
    const params = new URLSearchParams(location.search);
    params.delete('preview');
    const qs = params.toString();
    return `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`;
  }, [location]);

  // 更换 path 时刷新 iframe
  useEffect(() => setReloadKey((k) => k + 1), [embedUrl]);

  return (
    <div className="min-h-screen flex flex-col items-center bg-gradient-to-br from-slate-900 to-slate-700 py-8 px-4 text-white">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold">📱 小程序预览 · Mini-Program Preview</h1>
        <p className="mt-1 text-sm text-slate-300">
          客户端（sales-web）的移动端适配视图 · 375×812 (iPhone 14 Pro)
        </p>
        <p className="mt-1 text-xs text-slate-400">
          这不是微信小程序 runtime，而是同一套 React 代码在移动视口下的表现。
          <br />
          真正的微信小程序 (Taro) 在 <code className="bg-slate-800 px-1 rounded">miniprogram/</code>，需用微信开发者工具打开。
        </p>
      </div>

      {/* 手机壳 */}
      <div
        className="relative rounded-[48px] bg-black shadow-2xl"
        style={{
          width: DEVICE.width + DEVICE.bezel * 2,
          height: DEVICE.height + DEVICE.bezel * 2 + DEVICE.notch,
          padding: DEVICE.bezel,
          paddingTop: DEVICE.bezel + DEVICE.notch,
        }}
      >
        {/* 顶部刘海 */}
        <div
          className="absolute top-2 left-1/2 -translate-x-1/2 bg-black rounded-full"
          style={{ width: 120, height: 28, zIndex: 1 }}
        />
        {/* 屏幕 */}
        <iframe
          key={reloadKey}
          title="sales-web mobile preview"
          src={embedUrl}
          className="rounded-[36px] bg-white"
          style={{
            width: DEVICE.width,
            height: DEVICE.height,
            border: 'none',
          }}
        />
      </div>

      {/* 底部快捷链接 */}
      <div className="mt-6 flex flex-wrap gap-3 justify-center text-sm">
        <QuickLink to="/" label="首页" />
        <QuickLink to="/hotels" label="酒店" />
        <QuickLink to="/transfers" label="接送" />
        <QuickLink to="/visas" label="签证" />
        <QuickLink to="/bundles" label="套餐" />
        <QuickLink to="/cart" label="购物车" />
        <QuickLink to="/orders" label="订单" />
      </div>

      <div className="mt-6 text-xs text-slate-400 max-w-md text-center">
        提示：手机壳里点任何链接都会正常导航。想关闭预览模式，只需把 URL 里的{' '}
        <code className="bg-slate-800 px-1 rounded">?preview=mobile</code> 去掉。
      </div>

      {/* 退出按钮 */}
      <Link
        to={embedUrl}
        className="mt-4 inline-block rounded-md bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/20"
      >
        ↩ 退出预览（回全屏视图）
      </Link>
    </div>
  );
}

function QuickLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={`${to}?preview=mobile`}
      className="rounded-md bg-white/10 px-3 py-1 text-white hover:bg-white/20"
    >
      {label}
    </Link>
  );
}
