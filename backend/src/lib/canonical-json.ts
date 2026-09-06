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
 * 其余与 `JSON.stringify` 一致 —— 对象里值为 undefined 的键该丢就丢。
 */
export function canonicalJson(value: CanonicalJsonInput): string {
  return JSON.stringify(sortDeep(value));
}

/**
 * 可参与指纹比对的值：**除顶层 `undefined` 之外的一切**（null、数字、字符串、布尔、对象、数组）。
 *
 * 为什么要把顶层 undefined 挡在门外：`JSON.stringify(undefined)` 返回的是 `undefined` 而不是
 * 字符串，指纹一旦可能是 undefined，`a !== b` 的比对就再也说明不了问题 —— 两份都读不出来的
 * 入参会被判成「一致」，读得出的那份又永远判成「不一致」。收窄入参比把返回类型放宽成
 * `string | undefined` 更好：调用方不必为一个根本不该出现的分支写兜底。
 * 对象/数组**内部**的 undefined 不受影响，照 JSON.stringify 的老规矩处理。
 */
export type CanonicalJsonInput = NonNullable<unknown> | null;

/** 递归重建：对象换成按键名升序的新对象，数组逐个处理但不重排，其余原样返回。 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  // C-28：Date 实例 typeof 是 'object'，但没有自有可枚举属性——Object.keys(new Date()) 是
  // 空数组，不特殊处理的话会被下面的循环静默序列化成 {}，两个不同的 Date 会被判成同一份指纹。
  // 目前 canonicalJson 的两个调用方（orchestrationFingerprint/legActionFingerprint）入参都不含
  // Date 字段，暂时触发不到；这里照 JSON.stringify 的行为提前转成 ISO 字符串兜底，防止未来有
  // 调用方往指纹对象里加一个 Date 字段时悄悄踩这个坑。
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = sortDeep(source[key]);
  return out;
}
