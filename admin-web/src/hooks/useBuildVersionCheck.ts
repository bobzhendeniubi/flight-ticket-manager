import { useCallback, useEffect, useRef, useState } from 'react';

// 5 分钟轮询一次——够快能在合理时间内探测到发版，又不至于给 nginx 添无谓负载。
const POLL_INTERVAL_MS = 5 * 60 * 1000;
// focus / visibilitychange 触发的检查之间至少间隔这么久：用户来回切标签页/切窗口可能几秒内
// 连续触发好几次，别把每次都打到 /version.json。定时轮询本身按 POLL_INTERVAL_MS 走，不受此限。
const MIN_CHECK_INTERVAL_MS = 30 * 1000;

interface VersionPayload {
  buildId?: unknown;
}

interface UseBuildVersionCheckResult {
  /** 探测到服务端构建号与本次打开页面时不一致 */
  hasNewVersion: boolean;
  /** 探测到的最新构建号；未探测到变化时为 null */
  buildId: string | null;
}

/**
 * 发版后已打开的标签页仍在跑旧 JS bundle，对着新后端会报出莫名其妙的错误
 * （如某次线上事故：护照有效期校验被旧代码误判为必填失败）。
 * 这个 hook 轮询 /version.json，把返回的构建号与打包期注入的 __APP_BUILD_ID__ 比对，
 * 探测出"页面该刷新了"，交给 BuildVersionBanner 提示用户。
 *
 * dev 模式下 vite dev 不产出 dist/version.json，请求会 404 或落到 SPA 回退的 index.html
 * （非 JSON）——一律在 try/catch 里静默吞掉，不打印错误、不重试风暴，什么都不做。
 */
export function useBuildVersionCheck(): UseBuildVersionCheckResult {
  const [remoteBuildId, setRemoteBuildId] = useState<string | null>(null);
  // 防止同一时刻轮询 / visibilitychange / focus 三个触发源重叠发请求
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  // 上一次真正发出检查请求的时间戳，用于 focus/visibilitychange 的最小间隔节流
  const lastCheckedAtRef = useRef(0);

  const checkVersion = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    lastCheckedAtRef.current = Date.now();
    try {
      const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) return;
      const data = (await res.json()) as VersionPayload;
      if (!mountedRef.current) return;
      if (typeof data.buildId === 'string' && data.buildId) {
        setRemoteBuildId(data.buildId);
      }
    } catch {
      // 网络错误 / dev 模式下没有这个文件——静默忽略，不影响正常使用
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void checkVersion();

    const timer = window.setInterval(() => void checkVersion(), POLL_INTERVAL_MS);
    // focus/visibilitychange 距上次检查不足 30s 就跳过——定时轮询不受影响，仍按 POLL_INTERVAL_MS 走。
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastCheckedAtRef.current >= MIN_CHECK_INTERVAL_MS) {
        void checkVersion();
      }
    };
    const handleFocus = () => {
      if (Date.now() - lastCheckedAtRef.current >= MIN_CHECK_INTERVAL_MS) void checkVersion();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleFocus);

    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleFocus);
    };
  }, [checkVersion]);

  const hasNewVersion = remoteBuildId !== null && remoteBuildId !== __APP_BUILD_ID__;

  return { hasNewVersion, buildId: hasNewVersion ? remoteBuildId : null };
}
