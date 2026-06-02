/**
 * 安全的 UUID/random ID 生成。
 *
 * 背景：`crypto.randomUUID()` 要求 **secure context**（HTTPS 或 localhost/127.0.0.1）。
 * staging 跑在 `http://47.83.249.163/`（裸 IP 走 http）—— 不是 secure context。
 * 调用 `crypto.randomUUID()` 会抛 `DOMException: ... in non-secure contexts`。
 *
 * 这是 5 月 31 日散客 + 李孟反馈"购物车→结算点了空白页"的根因：CheckoutPage
 * useMemo 里调用 randomUUID 抛错 → React 整树卸载 → 白屏。
 *
 * 检查 `'randomUUID' in crypto` 并 **不** 能避开 —— 该属性在 insecure 上下文里
 * 也是 truthy（函数对象存在，只是调用时才抛）。必须 try/catch。
 */
export function safeRandomUUID(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // not a secure context — fall through to timestamp+random fallback
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
