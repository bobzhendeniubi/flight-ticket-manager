import { useEffect, useState } from 'react';
import { api, type HotelAvailabilityTier } from './api';

/**
 * 单个套餐的实时房量档位 —— 按 (房型, 入住, 退房) 查后台房控销控板。
 *
 * 后台公开端点 GET /products/hotel-availability 只回档位不回原始数字
 * （与六档余位同纪律）。tier=null 表示该时段未配置包房，前台不展示房量、
 * 也不拦截销售。每张套餐卡的住宿区间不同，天然一卡一次请求。
 *
 * 返回值：
 *   'loading' —— 查询中
 *   null      —— 无包房配置（不展示房量徽章）
 *   档位      —— SOLD_OUT / LOW / TIGHT / AMPLE
 */
export type HotelAvailabilityState = HotelAvailabilityTier | null | 'loading';

export function useHotelAvailability(
  hotelRoomTypeId: string | null | undefined,
  checkIn: string,
  checkOut: string,
): HotelAvailabilityState {
  const [state, setState] = useState<HotelAvailabilityState>(
    hotelRoomTypeId ? 'loading' : null,
  );

  useEffect(() => {
    if (!hotelRoomTypeId || !checkIn || !checkOut || checkIn >= checkOut) {
      setState(null);
      return;
    }
    let cancelled = false;
    setState('loading');
    api
      .getHotelAvailability({ hotelRoomTypeId, checkIn, checkOut })
      .then((r) => {
        if (!cancelled) setState(r.tier);
      })
      .catch(() => {
        // 查询失败按"无数据"处理：不展示房量、不拦截销售（不造假）
        if (!cancelled) setState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [hotelRoomTypeId, checkIn, checkOut]);

  return state;
}
