import { BadRequestError } from '../../lib/errors.js';

const UNMARKED_RANDOM_HOTEL_MESSAGE =
  '「随机档」不是酒店：随机档房量 = 同星级真酒店包房合计，不需要也不能新建同名酒店；要调随机档余量请给真实酒店切房';
const PLACEHOLDER_HOTEL_INACTIVE_MESSAGE =
  '随机档占位酒店不能下架：套餐绑定在它上面，下架后这些套餐会整体无法录单';

export interface HotelGuardState {
  name: string;
  starRating: number;
  intlFiveStar: boolean;
  randomTierPlaceholder: number | null;
}

export interface HotelGuardUpdate {
  name?: string;
  isActive?: boolean;
  starRating?: number;
  intlFiveStar?: boolean;
}

/** 名字带「随机」只能用于已有随机档占位酒店，普通酒店不得占用这个命名空间。 */
export function assertHotelNameAllowed(name: string | undefined, randomTierPlaceholder: number | null | undefined): void {
  if (name?.includes('随机') && randomTierPlaceholder == null) {
    throw new BadRequestError(UNMARKED_RANDOM_HOTEL_MESSAGE);
  }
}

/** 校验酒店 PATCH 的最终生效名称、占位酒店下架和占位档次不变量。 */
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
}

/** 删除酒店是软删，但随机档占位酒店仍不得被下架。 */
export function assertHotelDeleteAllowed(existing: HotelGuardState): void {
  if (existing.randomTierPlaceholder != null) {
    throw new BadRequestError(PLACEHOLDER_HOTEL_INACTIVE_MESSAGE);
  }
}
