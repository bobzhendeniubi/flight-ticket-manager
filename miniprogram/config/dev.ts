export default function (cfg: Record<string, unknown>) {
  return {
    ...cfg,
    defineConstants: {
      ...(cfg.defineConstants as Record<string, unknown>),
      // staging：阿里云 HK，IP 直连；WeChat DevTools 需勾选"不校验合法域名"才能 HTTP
      // 想跑本地 backend 改回 'http://localhost:4000'
      API_BASE: JSON.stringify('http://47.83.249.163/api'),
    },
  };
}
