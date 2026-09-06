import { BadRequestError } from '../../lib/errors.js';
import { isBlankCityCode } from '../hotel-control/hotel-city.js';

const UNMARKED_RANDOM_HOTEL_MESSAGE =
  '「随机档」不是酒店：随机档房量 = 同城市同星级真酒店包房合计，不需要也不能新建同名酒店；要调随机档余量请给真实酒店切房';
const PLACEHOLDER_HOTEL_INACTIVE_MESSAGE =
  '随机档占位酒店不能下架：套餐绑定在它上面，下架后这些套餐会整体无法录单';
const PLACEHOLDER_CITY_REQUIRED_MESSAGE =
  '随机档占位酒店必须填写城市代码：随机档按城市圈定，没有城市就不知道该在哪个城市加房';

export interface HotelGuardState {
  name: string;
  starRating: number;
  intlFiveStar: boolean;
  randomTierPlaceholder: number | null;
  cityCode: string;
}

export interface HotelGuardUpdate {
  name?: string;
  isActive?: boolean;
  starRating?: number;
  intlFiveStar?: boolean;
  cityCode?: string;
}

/** 名字带「随机」只能用于已有随机档占位酒店，普通酒店不得占用这个命名空间。 */
export function assertHotelNameAllowed(name: string | undefined, randomTierPlaceholder: number | null | undefined): void {
  if (name?.includes('随机') && randomTierPlaceholder == null) {
    throw new BadRequestError(UNMARKED_RANDOM_HOTEL_MESSAGE);
  }
}

/**
 * 占位酒店的城市代码必填（随机档按城市圈定；占位酒店的城市就是它承载的套餐的城市）。
 * 建/改都走这一道：真酒店不在此闸（它们由 schema 的 min(2) 兜底）。
 */
export function assertPlaceholderCityCode(
  randomTierPlaceholder: number | null | undefined,
  cityCode: string | null | undefined,
): void {
  if (randomTierPlaceholder != null && isBlankCityCode(cityCode)) {
    throw new BadRequestError(PLACEHOLDER_CITY_REQUIRED_MESSAGE);
  }
}

/** 校验酒店 PATCH 的最终生效名称、占位酒店下架、占位档次与城市不变量。 */
export function assertHotelUpdateAllowed(existing: HotelGuardState, update: HotelGuardUpdate): void {
  assertHotelNameAllowed(update.name ?? existing.name, existing.randomTierPlaceholder);

  if (existing.randomTierPlaceholder == null) return;

  if (update.isActive === false) {
    throw new BadRequestError(PLACEHOLDER_HOTEL_INACTIVE_MESSAGE);
  }
  const finalStar = update.starRating ?? existing.starRating;
  if (finalStar !== existing.randomTierPlaceholder) {
    throw new BadRequestError('占位酒店星级必须与随机档档次一致');
  }
  const finalIntlFiveStar = update.intlFiveStar ?? existing.intlFiveStar;
  if (finalIntlFiveStar) {
    throw new BadRequestError('占位酒店不能标记为国际五星');
  }
  assertPlaceholderCityCode(existing.randomTierPlaceholder, update.cityCode ?? existing.cityCode);
}

/** 删除酒店是软删，但随机档占位酒店仍不得被下架。 */
export function assertHotelDeleteAllowed(existing: HotelGuardState): void {
  if (existing.randomTierPlaceholder != null) {
    throw new BadRequestError(PLACEHOLDER_HOTEL_INACTIVE_MESSAGE);
  }
}
