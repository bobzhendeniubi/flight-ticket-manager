/**
 * 航班详情 — 预留页面。
 *
 * MVP 中首页 FlightCard 已经直接支持"点卡片加购"，所以本页暂时只是占位。
 * 将来可以加：航班图表 / 其他日期 / 真实座位图选座。
 */
import Taro from '@tarojs/taro';
import { View, Text } from '@tarojs/components';

export default function FlightDetailPage() {
  const scheduleId = Taro.getCurrentInstance().router?.params.scheduleId as string | undefined;
  return (
    <View style={{ padding: '48rpx', textAlign: 'center' }}>
      <Text style={{ color: '#64748b' }}>航班详情页（scheduleId={scheduleId ?? '—'}）</Text>
      <Text style={{ display: 'block', marginTop: '16rpx', fontSize: '24rpx', color: '#94a3b8' }}>
        MVP 首页已支持直接加购；此页用于未来的扩展（座位图、其他日期对比）
      </Text>
    </View>
  );
}
