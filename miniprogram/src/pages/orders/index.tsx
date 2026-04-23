/**
 * 订单列表 —— 只显示当前用户自己的订单（后端 /orders?mine=1 过滤）。
 */
import { useEffect, useState, useCallback } from 'react';
import Taro, { useDidShow } from '@tarojs/taro';
import { View, Text, ScrollView } from '@tarojs/components';
import { api, ApiError } from '../../lib/api';
import type { OrderSummary, OrderStatus } from '../../lib/types';
import { useAuth } from '../../stores/auth';
import './index.scss';

const STATUS_LABEL: Record<OrderStatus, { label: string; color: string }> = {
  DRAFT: { label: '草稿', color: '#64748b' },
  PENDING_PAYMENT: { label: '待支付', color: '#d97706' },
  PAID: { label: '已支付', color: '#16a34a' },
  PROCESSING: { label: '出票中', color: '#2563eb' },
  TICKETED: { label: '已出票', color: '#059669' },
  COMPLETED: { label: '已完成', color: '#059669' },
  CANCELLED: { label: '已取消', color: '#6b7280' },
  PAYMENT_TIMEOUT: { label: '支付超时', color: '#dc2626' },
  REFUND_REQUESTED: { label: '退款中', color: '#d97706' },
  REFUNDED: { label: '已退款', color: '#6b7280' },
  CHANGE_REQUESTED: { label: '改签中', color: '#d97706' },
  CHANGED: { label: '已改签', color: '#16a34a' },
  FAILED: { label: '出票失败', color: '#dc2626' },
};
const STATUS_FALLBACK = { label: '未知状态', color: '#64748b' } as const;

export default function OrdersPage() {
  const { user, tokens, hydrate, hydrated } = useAuth();
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated) hydrate();
  }, [hydrate, hydrated]);

  const load = useCallback(async () => {
    if (!hydrated) return;
    if (!user || !tokens) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await api.listMyOrders(tokens.accessToken);
      setOrders(r.orders);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoading(false);
      Taro.stopPullDownRefresh();
    }
  }, [hydrated, user, tokens]);

  useEffect(() => { void load(); }, [load]);
  useDidShow(() => { void load(); });

  if (!user) {
    return (
      <View className='orders-page empty'>
        <Text>请先登录查看订单</Text>
        <View className='btn-primary' onClick={() => Taro.navigateTo({ url: '/pages/login/index' })}>
          去登录
        </View>
      </View>
    );
  }

  if (loading) {
    return <View className='orders-page empty'>加载中…</View>;
  }
  if (error) {
    return <View className='orders-page empty error'>{error}</View>;
  }
  if (orders.length === 0) {
    return (
      <View className='orders-page empty'>
        <Text className='emoji'>📋</Text>
        <Text>暂无订单</Text>
        <View className='btn-primary' onClick={() => Taro.switchTab({ url: '/pages/index/index' })}>
          去下单
        </View>
      </View>
    );
  }

  return (
    <ScrollView className='orders-page' scrollY>
      {orders.map((o) => {
        const st = STATUS_LABEL[o.status] ?? STATUS_FALLBACK;
        return (
          <View
            key={o.id}
            className='card order'
            onClick={() => Taro.navigateTo({ url: `/pages/order-detail/index?id=${o.id}` })}
          >
            <View className='order-head'>
              <Text className='order-number'>{o.orderNumber}</Text>
              <Text className='status' style={{ color: st.color }}>{st.label}</Text>
            </View>
            <View className='order-items'>
              {o.items.slice(0, 2).map((it) => (
                <Text key={it.id} className='order-item-line'>
                  · {it.description}
                </Text>
              ))}
              {o.items.length > 2 && <Text className='more'>+{o.items.length - 2} 项</Text>}
            </View>
            <View className='order-footer'>
              <Text className='order-date'>{o.createdAt.slice(0, 10)}</Text>
              <Text className='text-price'>¥{Number(o.total).toLocaleString()}</Text>
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}
