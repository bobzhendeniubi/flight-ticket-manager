/**
 * 前端报错上报的启动接线：main.tsx 的第一个 import，在入口里最先挂好全局监听。
 * 覆盖不到的：它依赖的 api.ts 所在的公共块（app-core）与 vendor 块会先求值，那两块自身的求值异常
 * 报不上来（出这种错全站打不开，本来也会被立刻发现）；页面代码加载失败由 LazyPage 单独上报。
 * 上报地址跟随 API_BASE（生产 VITE_API_BASE / 默认 /api 走 nginx 反代）。
 */
import { API_BASE } from './api';
import { initClientErrorReporting } from './clientErrorReporter';

initClientErrorReporting({
  app: 'admin',
  endpoint: `${API_BASE}/client-errors`,
  buildVersion: __APP_BUILD_ID__,
});
