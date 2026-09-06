/**
 * 随机档的城市维度。
 *
 * 城市的事实源 = `Hotel.cityCode`。随机档聚合 = **同 cityCode × 同 starRating** 的真酒店包房合计，
 * 岘港三星的缺口绝不吃会安三星的库存（房控在错的城市加房 = 库存口径事故）。
 *
 * 这里只放「城市码 → 展示名」的小映射与归一化，**不建**全局机场/城市库（航线派生另有分支在做）；
 * 查不到的码原样显示，不抛错。
 */

/**
 * 存量默认城市：上线前业务只在岘港，两类没有城市信息的随机占用一律归这里 ——
 *   · 存量占位酒店 cityCode 为空的（迁移里已回填 DAD）；
 *   · 单独 HOTEL 行的 `randomStarTier`（后台直接录「三星随机」，行上没有酒店、也就没有城市）。
 */
export const RANDOM_TIER_LEGACY_CITY_CODE = 'DAD';

const CITY_LABELS: Readonly<Record<string, string>> = {
  DAD: '岘港',
  HOA: '会安',
  BAN: '巴拿山',
};

/** 城市码是否为空（只有空白也算空）；占位酒店守卫用。 */
export function isBlankCityCode(raw: string | null | undefined): boolean {
  return (raw ?? '').trim() === '';
}

/**
 * 归一化城市码：去首尾空白 + 大写；空 → 存量默认城市。
 * 聚合按等值匹配，'dad' 与 'DAD ' 必须算同一个城市（写入侧与迁移同样归一）。
 */
export function normalizeCityCode(raw: string | null | undefined): string {
  const code = (raw ?? '').trim().toUpperCase();
  return code === '' ? RANDOM_TIER_LEGACY_CITY_CODE : code;
}

/** 城市展示名：DAD → 「岘港」；未知码原样返回（归一化后），绝不返回 undefined。 */
export function cityLabel(cityCode: string | null | undefined): string {
  const code = normalizeCityCode(cityCode);
  return CITY_LABELS[code] ?? code;
}

/** 城市分组标题：「岘港（DAD）」；未知码 → 「XYZ」（不重复写两遍）。 */
export function cityGroupTitle(cityCode: string | null | undefined): string {
  const code = normalizeCityCode(cityCode);
  const label = CITY_LABELS[code];
  return label ? `${label}（${code}）` : code;
}

/** 城市排序：存量默认城市（主营地）永远排最前，其余按码升序。 */
export function compareCityCodes(a: string, b: string): number {
  if (a === b) return 0;
  if (a === RANDOM_TIER_LEGACY_CITY_CODE) return -1;
  if (b === RANDOM_TIER_LEGACY_CITY_CODE) return 1;
  return a.localeCompare(b);
}
