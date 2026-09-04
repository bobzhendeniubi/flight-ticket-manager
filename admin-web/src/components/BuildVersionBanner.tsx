import { useEffect, useState } from 'react';
import { useBuildVersionCheck } from '../hooks/useBuildVersionCheck';

const DISMISS_STORAGE_KEY = 'ftm.buildVersionBanner.dismissedUntil';
const DISMISS_DURATION_MS = 10 * 60 * 1000; // 「稍后」= 10 分钟内不再打扰

function readDismissedUntil(): number {
  try {
    const raw = sessionStorage.getItem(DISMISS_STORAGE_KEY);
    return raw ? Number(raw) : 0;
  } catch {
    return 0;
  }
}

/**
 * 「新版本已发布，请刷新」提示条。
 * 根因（0904 实测事故）：发版后已打开的标签页仍在跑旧 JS bundle，对着新后端接口报出
 * 莫名其妙的错误（护照有效期校验被误判为必填失败）。轮询探测到构建号变化就常驻提醒，
 * 直到用户刷新——点「稍后」只是 10 分钟内不再打扰，不是关掉提醒，旧 bundle 还在跑。
 */
export function BuildVersionBanner() {
  const { hasNewVersion } = useBuildVersionCheck();
  const [dismissedUntil, setDismissedUntil] = useState(readDismissedUntil);

  useEffect(() => {
    if (!hasNewVersion) return;
    // 每次新探测到版本变化都重读一次「稍后」记忆，避免用旧闭包判断过期时间
    setDismissedUntil(readDismissedUntil());
  }, [hasNewVersion]);

  // 「稍后」snooze 期间没有任何东西会触发重渲染——不到期不会自动回来。
  // 用定时器在 dismissedUntil 那一刻把状态清零，逼一次重渲染，横幅到点自动重新出现。
  useEffect(() => {
    if (dismissedUntil <= Date.now()) return;
    const delay = dismissedUntil - Date.now();
    const timer = window.setTimeout(() => setDismissedUntil(0), delay);
    return () => window.clearTimeout(timer);
  }, [dismissedUntil]);

  if (!hasNewVersion || dismissedUntil > Date.now()) return null;

  const dismiss = () => {
    const until = Date.now() + DISMISS_DURATION_MS;
    try {
      sessionStorage.setItem(DISMISS_STORAGE_KEY, String(until));
    } catch {
      // 存不进去就只影响这次记忆，不影响本次隐藏
    }
    setDismissedUntil(until);
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 md:px-6 lg:px-8"
    >
      <span className="font-medium">
        系统已发布新版本，请刷新页面后继续操作（未保存的表单请先保存）
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button type="button" className="btn-primary py-1.5" onClick={() => window.location.reload()}>
          立即刷新
        </button>
        <button type="button" className="btn-ghost py-1.5" onClick={dismiss}>
          稍后
        </button>
      </div>
    </div>
  );
}
