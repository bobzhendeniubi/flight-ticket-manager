/**
 * 前端报错上报的启动接线：main.tsx 的第一个 import。
 * 放在业务模块求值之前挂好全局监听，连「启动即白屏」的模块求值异常也能报上来。
 * 上报地址跟随 API_BASE（生产 VITE_API_BASE / 默认 /api 走 nginx 反代）。
 */
import { API_BASE } from './api';
import { initClientErrorReporting } from './clientErrorReporter';

initClientErrorReporting({
  app: 'sales',
  endpoint: `${API_BASE}/client-errors`,
  buildVersion: __APP_BUILD_ID__,
});
