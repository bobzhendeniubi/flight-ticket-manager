/**
 * 购物车页 — 显示已加购的航班（+未来：酒店/签证）+ 汇总总价 + 结账入口。
 */
import { useEffect } from 'react';
import Taro from '@tarojs/taro';
import { View, Text, ScrollView } from '@tarojs/components';
import { useCart } from '../../stores/cart';
import './index.scss';

const KIND_LABEL: Record<string, string> = {
  FLIGHT: '机票',
  HOTEL: '酒店',
  TRANSFER: '接送',
  VISA: '签证',
  BUNDLE: '套餐',
};

export default function CartPage() {
  const { items, hydrate, hydrated, remove } = useCart();

  useEffect(() => {
    if (!hydrated) hydrate();
  }, [hydrate, hydrated]);

  const total = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);

  return (
    <View className='cart-page'>
      <ScrollView className='scroll' scrollY>
        {items.length === 0 ? (
          <View className='card empty'>
            <Text className='emoji'>🛒</Text>
            <Text className='title'>购物车是空的</Text>
            <Text className='sub'>回首页选购航班</Text>
            <View
              className='btn-primary'
              onClick={() => Taro.switchTab({ url: '/pages/index/index' })}
            >
              去首页
            </View>
          </View>
        ) : (
          items.map((i, idx) => (
            <View key={idx} className='card item'>
              <View className='item-head'>
                <View className='badge kind'>{KIND_LABEL[i.kind] ?? i.kind}</View>
                <Text className='del' onClick={() => remove(idx)}>删除</Text>
              </View>
              <Text className='name'>{i.name}</Text>
              {i.description && <Text className='desc'>{i.description}</Text>}
              <View className='footer'>
                <Text className='qty'>×{i.qty}</Text>
                <Text className='text-price'>¥{(i.unitPrice * i.qty).toLocaleString()}</Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>

      {items.length > 0 && (
        <View className='summary'>
          <View className='total'>
            <Text>合计</Text>
            <Text className='text-price big'>¥{total.toLocaleString()}</Text>
          </View>
          <View
            className='btn-primary'
            onClick={() => Taro.navigateTo({ url: '/pages/checkout/index' })}
          >
            去结账
          </View>
        </View>
      )}
    </View>
  );
}
