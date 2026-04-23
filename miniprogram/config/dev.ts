export default function (cfg: Record<string, unknown>) {
  return {
    ...cfg,
    defineConstants: {
      ...(cfg.defineConstants as Record<string, unknown>),
      API_BASE: JSON.stringify('http://localhost:4000'),
    },
  };
}
