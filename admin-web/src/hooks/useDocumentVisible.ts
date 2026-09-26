import { useEffect, useState } from 'react';

/**
 * 当前标签页是否可见（document.visibilityState === 'visible'）。
 *
 * 顶栏 WorkOrderBell（60s 轮询）与仪表盘 RealtimeActivity（15s 轮询）曾经不管标签页在不在
 * 前台都照打——3.5 天里工单汇总一项就占了全部请求的 29%，半夜也在打。用这个 hook 在
 * useEffect 依赖里当闸门：隐藏时不建 interval（浏览器本来就会做节流，但不如干脆不发）；
 * 切回可见时 hook 返回值翻转，依赖它的 effect 重新跑一遍——只要 effect 本身在挂载时就会
 * 立即拉一次数据（现有两处轮询都是这个写法），就自然做到"切回可见立即刷新一次再回到定时"，
 * 不需要额外记"上次是不是隐藏的"状态。
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState<boolean>(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );

  useEffect(() => {
    const onVisibilityChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  return visible;
}
