/**
 * 首页 — 航班搜索 + 结果列表。
 *
 * Demo 默认：MFM → DAD，不限日期，1 人。
 * 用户可改出发地/目的地/日期/人数，显示动态价 + 限时优惠徽章（dynamicPrice<basePrice×0.95 时）。
 * 注意：dateRank A/B/C/D 是公司内部日期等级，绝不暴露给客户。
 */
import { useEffect, useState, useCallback } from 'react';
import Taro, { useDidShow } from '@tarojs/taro';
import { View, Text, ScrollView, Picker, Input } from '@tarojs/components';
import { api, ApiError } from '../../lib/api';
import type { FlightSearchResult } from '../../lib/types';
import { airportLabel, formatLocalDate, formatLocalTime, CABIN_LABEL } from '../../lib/airports';
import { useAuth } from '../../stores/auth';
import { useCart } from '../../stores/cart';
import './index.scss';

const AIRPORT_OPTIONS = [
  { code: 'MFM', label: '澳门' },
  { code: 'DAD', label: '岘港' },
  { code: 'HKG', label: '香港' },
  { code: 'PVG', label: '上海' },
];

export default function Index() {
  const hydrateAuth = useAuth((s) => s.hydrate);
  const hydrateCart = useCart((s) => s.hydrate);

  const [origin, setOrigin] = useState('MFM');
  const [destination, setDestination] = useState('DAD');
  const [date, setDate] = useState('');
  const [passengers, setPassengers] = useState(1);
  const [results, setResults] = useState<FlightSearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hydrateAuth();
    hydrateCart();
  }, [hydrateAuth, hydrateCart]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.searchFlights({ origin, destination, date: date || undefined, passengers });
      setResults(r.results);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoading(false);
      Taro.stopPullDownRefresh();
    }
  }, [origin, destination, date, passengers]);

  useEffect(() => { void load(); }, [load]);
  useDidShow(() => { /* 切 tab 回来会触发；MVP 不重新拉 */ });

  Taro.usePullDownRefresh = Taro.usePullDownRefresh ?? (() => { /* polyfill */ });

  return (
    <ScrollView className='home-page' scrollY>
      {/* 搜索栏 */}
      <View className='card search-card'>
        <View className='row'>
          <View className='col'>
            <Text className='label'>出发地</Text>
            <Picker
              mode='selector'
              range={AIRPORT_OPTIONS.map((a) => a.label)}
              value={AIRPORT_OPTIONS.findIndex((a) => a.code === origin)}
              onChange={(e) => setOrigin(AIRPORT_OPTIONS[Number(e.detail.value)].code)}
            >
              <View className='input'>{airportLabel(origin)}</View>
            </Picker>
          </View>
          <View className='col'>
            <Text className='label'>目的地</Text>
            <Picker
              mode='selector'
              range={AIRPORT_OPTIONS.map((a) => a.label)}
              value={AIRPORT_OPTIONS.findIndex((a) => a.code === destination)}
              onChange={(e) => setDestination(AIRPORT_OPTIONS[Number(e.detail.value)].code)}
            >
              <View className='input'>{airportLabel(destination)}</View>
            </Picker>
          </View>
        </View>
        <View className='row'>
          <View className='col'>
            <Text className='label'>出发日期（留空=全部）</Text>
            <Picker mode='date' value={date} onChange={(e) => setDate(e.detail.value)}>
              <View className='input'>{date || '不限'}</View>
            </Picker>
          </View>
          <View className='col'>
            <Text className='label'>人数</Text>
            <Input
              type='number'
              value={String(passengers)}
              onInput={(e) => setPassengers(Math.max(1, Math.min(9, Number(e.detail.value) || 1)))}
              className='input'
            />
          </View>
        </View>
      </View>

      {/* 结果列表 */}
      {loading && <View className='card text-muted'>加载中…</View>}
      {error && <View className='card error'>{error}</View>}
      {!loading && !error && results.length === 0 && (
        <View className='card text-muted'>没有符合条件的航班</View>
      )}
      {results.map((r) => (
        <FlightCard key={r.scheduleId} flight={r} passengers={passengers} />
      ))}
    </ScrollView>
  );
}

function FlightCard({ flight, passengers }: { flight: FlightSearchResult; passengers: number }) {
  const add = useCart((s) => s.add);
  const minCabin = flight.seatClasses
    .filter((c) => c.available >= passengers)
    .reduce(
      (m, c) => (m === null || Number(c.dynamicPrice) < Number(m.dynamicPrice) ? c : m),
      null as typeof flight.seatClasses[number] | null,
    );
  // dateRank A/B/C/D 是公司内部日期等级，绝不展示给客户。
  // 用 dynamicPrice < basePrice × 0.95 反映"相对优惠"。
  const baseMin = flight.seatClasses
    .filter((c) => c.available >= passengers)
    .reduce(
      (m, c) => (m === null || Number(c.basePrice) < m ? Number(c.basePrice) : m),
      null as number | null,
    );
  const dynMin = minCabin ? Number(minCabin.dynamicPrice) : null;
  const isDeal = baseMin !== null && dynMin !== null && dynMin < baseMin * 0.95;

  return (
    <View className='card flight-card'>
      <View className='flight-header'>
        <Text className='flight-number'>{flight.flightNumber}</Text>
        {isDeal && <View className='badge badge-deal'>限时优惠</View>}
      </View>
      <View className='flight-route'>
        <View className='route-side'>
          <Text className='time'>{formatLocalTime(flight.departureTime, flight.departureTz)}</Text>
          <Text className='airport'>{flight.originCode}</Text>
          <Text className='date'>{formatLocalDate(flight.departureTime, flight.departureTz)}</Text>
        </View>
        <View className='route-arrow'>
          <Text className='duration'>{Math.floor(flight.durationMinutes / 60)}h {flight.durationMinutes % 60}m</Text>
          <View className='line'></View>
        </View>
        <View className='route-side'>
          <Text className='time'>{formatLocalTime(flight.arrivalTime, flight.arrivalTz)}</Text>
          <Text className='airport'>{flight.destinationCode}</Text>
          <Text className='date'>{formatLocalDate(flight.arrivalTime, flight.arrivalTz)}</Text>
        </View>
      </View>

      <View className='cabin-list'>
        {flight.seatClasses.map((c) => {
          const enough = c.available >= passengers;
          const showLine = Number(c.dynamicPrice) !== Number(c.basePrice);
          return (
            <View
              key={c.cabin}
              className={`cabin-row ${enough ? '' : 'disabled'}`}
              onClick={() => {
                if (!enough) return;
                add({
                  kind: 'FLIGHT',
                  productId: flight.scheduleId,
                  name: `${flight.flightNumber} ${flight.originCode}→${flight.destinationCode} · ${CABIN_LABEL[c.cabin]} × ${passengers}`,
                  description: `${formatLocalDate(flight.departureTime, flight.departureTz)} ${formatLocalTime(flight.departureTime, flight.departureTz)}`,
                  unitPrice: c.totalForQty,
                  qty: 1,
                  meta: {
                    departureTime: flight.departureTime,
                    cabin: c.cabin,
                    passengers,
                    // dateRank 是内部字段，不放进 cart meta（之前订单页/购物车显示给客户）
                    basePrice: Number(c.basePrice),
                    totalForQty: c.totalForQty,
                  },
                });
                Taro.showToast({ title: `${CABIN_LABEL[c.cabin]} × ${passengers} 已加入购物车`, icon: 'success' });
              }}
            >
              <View className='cabin-info'>
                <Text className='cabin-name'>{CABIN_LABEL[c.cabin] ?? c.cabin}</Text>
                <Text className='avail'>余票 {c.available >= 9 ? '9+' : c.available}</Text>
              </View>
              <View className='cabin-price'>
                {showLine && <Text className='text-price-line'>¥{Number(c.basePrice).toFixed(0)}</Text>}
                <Text className='text-price'>¥{Number(c.dynamicPrice).toFixed(0)}</Text>
              </View>
            </View>
          );
        })}
      </View>

      {minCabin && (
        <View className='footer'>
          <Text className='footer-label'>最低起价</Text>
          <Text className='text-price'>¥{Number(minCabin.dynamicPrice).toFixed(0)}/人</Text>
        </View>
      )}
    </View>
  );
}
