export default function (cfg: Record<string, unknown>) {
  return {
    ...cfg,
    defineConstants: {
      ...(cfg.defineConstants as Record<string, unknown>),
      // TODO: 正式上线前换回 https://api.citur.com（域名 + HTTPS + WeChat 后台白名单）
      // 当前 staging 直连阿里云 HK，WeChat DevTools 需勾"不校验合法域名"才能跑 HTTP
      API_BASE: JSON.stringify('http://47.83.249.163/api'),
    },
  };
}
