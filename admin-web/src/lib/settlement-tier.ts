import type { Hotel, SettlementTier } from './api';

// 结算价档次中文名与 backend orders.service resolveHotelSettlementTier 同步。
export const SETTLEMENT_TIER_ZH: Record<SettlementTier, string> = {
  CITY_3STAR: '市区三星',
  CITY_4STAR: '市区四星',
  CITY_5STAR: '市区五星',
  INTL_5STAR: '国际五星',
};

/**
 * 酒店 → 它属于哪个结算档次（与 backend orders.service resolveHotelSettlementTier 同步，口径必须一字不差）。
 * 映射不到任何档次（星级缺失 / 1、2 星 / 标了国际五星却不是 5 星）返回 null，按「不匹配」处理。
 * 前端照抄这份口径，是为了让「提交时会不会被服务端星级闸拦下」在界面上先算得准 ——
 * 只按星级数字比会把「市区五星 vs 国际五星」当成匹配，运营一路填到提交才吃 400。
 */
export function resolveHotelSettlementTier(hotel: {
  starRating?: number | null;
  intlFiveStar?: boolean | null;
}): SettlementTier | null {
  if (hotel.starRating == null) return null;
  if (hotel.intlFiveStar === true) return hotel.starRating === 5 ? 'INTL_5STAR' : null;
  if (hotel.starRating === 3) return 'CITY_3STAR';
  if (hotel.starRating === 4) return 'CITY_4STAR';
  if (hotel.starRating === 5) return 'CITY_5STAR';
  return null;
}

export interface BundleHotelGroups {
  sameTier: Hotel[];
  otherTier: Hotel[];
  placeholders: Hotel[];
}

/** 按套餐结算档次分组；星级随机档占位记录始终单独归入 placeholders。 */
export function groupHotelsByBundleTier(
  hotels: ReadonlyArray<Hotel>,
  settlementTier?: SettlementTier | null,
): BundleHotelGroups {
  const realHotels = hotels.filter((hotel) => hotel.randomTierPlaceholder == null);
  const placeholders = hotels.filter((hotel) => hotel.randomTierPlaceholder != null);
  if (settlementTier == null) {
    return { sameTier: realHotels, otherTier: [], placeholders };
  }

  const sameTier: Hotel[] = [];
  const otherTier: Hotel[] = [];
  for (const hotel of realHotels) {
    if (resolveHotelSettlementTier(hotel) === settlementTier) sameTier.push(hotel);
    else otherTier.push(hotel);
  }
  return { sameTier, otherTier, placeholders };
}
