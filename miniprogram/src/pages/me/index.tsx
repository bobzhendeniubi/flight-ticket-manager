/**
 * 我的页面 — 简化版。登录后显示昵称 + 基础导航；未登录显示登录 CTA。
 */
import { useEffect } from 'react';
import Taro from '@tarojs/taro';
import { View, Text } from '@tarojs/components';
import { useAuth } from '../../stores/auth';
import { useCart } from '../../stores/cart';
import './index.scss';

export default function MePage() {
  const { user, hydrate, hydrated, clear } = useAuth();
  const clearCart = useCart((s) => s.clear);

  useEffect(() => {
    if (!hydrated) hydrate();
  }, [hydrate, hydrated]);

  const logout = () => {
    Taro.showModal({
      title: '退出登录？',
      content: '退出后购物车会清空',
      success: (r) => {
        if (r.confirm) {
          clear();
          clearCart();
          Taro.showToast({ title: '已退出', icon: 'success' });
        }
      },
    });
  };

  return (
    <View className='me-page'>
      {/* 头部 */}
      <View className='hero'>
        {user ? (
          <>
            <View className='avatar'>👤</View>
            <Text className='nickname'>{user.displayName ?? '用户'}</Text>
            <Text className='sub'>{user.email ?? `ID: ${user.id.slice(-8)}`}</Text>
          </>
        ) : (
          <>
            <View className='avatar'>🔒</View>
            <Text className='nickname'>未登录</Text>
            <View
              className='btn-primary small'
              onClick={() => Taro.navigateTo({ url: '/pages/login/index' })}
            >
              登录 / 注册
            </View>
          </>
        )}
      </View>

      {/* 菜单 */}
      <View className='menu card'>
        <View
          className='row'
          onClick={() => Taro.switchTab({ url: '/pages/orders/index' })}
        >
          <Text className='icon'>📋</Text>
          <Text className='label'>我的订单</Text>
          <Text className='arr'>›</Text>
        </View>
        <View
          className='row'
          onClick={() => Taro.navigateTo({ url: '/pages/cart/index' })}
        >
          <Text className='icon'>🛒</Text>
          <Text className='label'>购物车</Text>
          <Text className='arr'>›</Text>
        </View>
      </View>

      <View className='menu card'>
        <View
          className='row'
          onClick={() =>
            Taro.showModal({
              title: '客服',
              content: 'support@citur.com\n+853 2888 8888',
              showCancel: false,
            })
          }
        >
          <Text className='icon'>💬</Text>
          <Text className='label'>联系客服</Text>
          <Text className='arr'>›</Text>
        </View>
        <View
          className='row'
          onClick={() =>
            Taro.showModal({
              title: '关于世途旅行',
              content: '澳门 ⇌ 岘港 · 越南专线\nM2.5 Release · 小程序 MVP',
              showCancel: false,
            })
          }
        >
          <Text className='icon'>ℹ️</Text>
          <Text className='label'>关于</Text>
          <Text className='arr'>›</Text>
        </View>
      </View>

      {user && (
        <View className='logout' onClick={logout}>
          退出登录
        </View>
      )}
    </View>
  );
}
