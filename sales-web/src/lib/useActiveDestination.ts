import { useEffect, useState } from 'react';
import { api } from './api';
import {
  DEFAULT_DESTINATION_CODE,
  getDestinationContent,
  type DestinationContent,
} from './content';

/**
 * 当前主推目的地 —— 全站营销位（页脚 / hero / 关于页）取文案的唯一入口。
 *
 * 「当前目的地」= 后端活跃航线表 `GET /public/routes` 第一条航线的目的地。首页的航线
 * 选择器也是这么取默认值的（拉到 routes 后用 routes[0]），两处口径一致；这里额外做了
 * 模块级缓存，页脚 / hero / 关于页共享同一次请求。
 *
 * 拉取失败 / 还没回来 / 拉到的目的地还没配文案 → 退回 DEFAULT_DESTINATION_CODE。
 * 营销文案兜底是安全的（顶多介绍了另一个目的地），价钱和库存类的航线派生一律不兜底。
 *
 * 限制（写明）：全站只呈现**一个**主推目的地。真开了第二条线之后，若要让页脚 / 关于页
 * 跟着买家正在浏览的那条线变，还需要一个「当前航线」的全局选择态（现在只有首页搜索框
 * 里的局部 state）；本批只把按目的地分组的结构做出来，没有引入这个全局态。
 */

/** 模块级缓存：一次会话只打一次 /public/routes，多个组件共享。 */
let cachedCode: string | null = null;
let inflight: Promise<string | null> | null = null;

function loadActiveDestinationCode(): Promise<string | null> {
  if (cachedCode !== null) return Promise.resolve(cachedCode);
  inflight ??= api
    .getPublicRoutes()
    .then((r) => {
      const code = r.routes[0]?.destinationCode ?? null;
      if (code) cachedCode = code;
      return code;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 当前主推目的地的机场码（还没拉到 / 拉失败 → 兜底码）。 */
export function useActiveDestinationCode(): string {
  const [code, setCode] = useState<string>(cachedCode ?? DEFAULT_DESTINATION_CODE);

  useEffect(() => {
    if (cachedCode !== null) return;
    let cancelled = false;
    void loadActiveDestinationCode().then((next) => {
      if (!cancelled && next) setCode(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return code;
}

/** 当前主推目的地的营销文案（没配这个目的地时退回兜底目的地的那组）。 */
export function useActiveDestinationContent(): DestinationContent {
  return getDestinationContent(useActiveDestinationCode());
}
