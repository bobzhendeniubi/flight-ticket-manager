/**
 * 键序无关的 JSON 序列化 —— 专供「同一份入参吗」这类指纹比对。
 *
 * 为什么不能直接 `JSON.stringify` 两边比：留档的指纹落在 Postgres 的 JSONB 列上，
 * JSONB 不保留写入时的键序（它按键长度 + 字节序重排），读回来的对象跟当初 stringify
 * 出来的串对不上。于是「原样重试」会被判成「换了一份入参」，运营侧看到的是莫名其妙的
 * 409，只能不停换请求编号重提。
 *
 * 口径：对象递归按键名升序后再 stringify；数组**保序**（顺序本身是语义的一部分，
 * 比如按人改期的 roomSplit 已经按 itemId 排过了，这里再排一次只会掩盖真实差异）。
 * 其余与 `JSON.stringify` 一致 —— undefined 该丢就丢。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/** 递归重建：对象换成按键名升序的新对象，数组逐个处理但不重排，其余原样返回。 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = sortDeep(source[key]);
  return out;
}
