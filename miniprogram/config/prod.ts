export default function (cfg: Record<string, unknown>) {
  return {
    ...cfg,
    defineConstants: {
      ...(cfg.defineConstants as Record<string, unknown>),
      // 生产环境 API 根（上线前改成真实域名 + 必须 HTTPS）
      API_BASE: JSON.stringify('https://api.citur.com'),
    },
  };
}
