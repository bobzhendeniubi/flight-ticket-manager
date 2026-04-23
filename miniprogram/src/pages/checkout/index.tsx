/**
 * 结账页 — 联系信息 + 乘客信息（张数=乘客数强制校验）+ 创建订单。
 *
 * 简化版（vs sales-web）：
 *   - 没有 OCR（小程序端 tesseract 太重，未来接后台真 OCR）
 *   - 只支持 WECHAT_PAY 方式
 *   - 创建订单成功后跳转到订单详情 → 付款按钮触发 wx.requestPayment
 */
import { useEffect, useMemo, useState } from 'react';
import Taro from '@tarojs/taro';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../stores/auth';
import { useCart } from '../../stores/cart';
import './index.scss';

interface PassengerForm {
  fullName: string;
  passportNumber: string;
  dateOfBirth: string;
  nationality: string;
}

const EMPTY: PassengerForm = {
  fullName: '',
  passportNumber: '',
  dateOfBirth: '',
  nationality: 'CN',
};

export default function CheckoutPage() {
  const { items, hydrate, hydrated, clear } = useCart();
  const { user, tokens, hydrate: hydrateAuth } = useAuth();

  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [passengers, setPassengers] = useState<PassengerForm[]>([{ ...EMPTY }]);
  const [submitting, setSubmitting] = useState(false);

  const idempotencyKey = useMemo(() => {
    return `mp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }, []);

  useEffect(() => {
    hydrateAuth();
    if (!hydrated) hydrate();
  }, [hydrate, hydrated, hydrateAuth]);

  // 机票张数 = 乘客数
  const flightQty = items
    .filter((i) => i.kind === 'FLIGHT')
    .reduce((s, i) => s + (Number(i.meta?.passengers) || i.qty), 0);
  const paxMismatch = flightQty > 0 && flightQty !== passengers.length;
  const total = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);

  const updatePassenger = (idx: number, patch: Partial<PassengerForm>) => {
    setPassengers((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };
  const addPassenger = () => setPassengers((p) => [...p, { ...EMPTY }]);
  const removePassenger = (idx: number) => setPassengers((p) => p.filter((_, i) => i !== idx));

  const submit = async () => {
    if (!user || !tokens) {
      Taro.showModal({
        title: '需要登录',
        content: '请先登录后再下单',
        confirmText: '去登录',
        success: (r) => {
          if (r.confirm) Taro.navigateTo({ url: '/pages/login/index' });
        },
      });
      return;
    }
    if (paxMismatch) {
      Taro.showToast({ title: `机票 ${flightQty} 张需 ${flightQty} 位乘客`, icon: 'none' });
      return;
    }
    if (!contactName.trim() || !contactPhone.trim()) {
      Taro.showToast({ title: '请填写联系人信息', icon: 'none' });
      return;
    }
    if (passengers.some((p) => !p.fullName.trim() || !p.passportNumber.trim() || !p.dateOfBirth)) {
      Taro.showToast({ title: '请填写所有乘客信息', icon: 'none' });
      return;
    }

    setSubmitting(true);
    try {
      const { order } = await api.createOrder(tokens.accessToken, {
        contactName,
        contactPhone,
        contactEmail: contactEmail || undefined,
        paymentMethod: 'WECHAT_PAY',
        idempotencyKey,
        items: items.flatMap((i) => {
          if (i.kind === 'FLIGHT') {
            return [{
              kind: 'FLIGHT',
              description: i.name,
              quantity: Number(i.meta?.passengers) || i.qty,
              flightScheduleId: i.productId,
              flightCabin: i.meta?.cabin,
              metadata: i.meta,
            }];
          }
          return [];
        }),
        passengers: passengers.map((p) => ({
          fullName: p.fullName,
          documentType: 'PASSPORT',
          documentNumber: p.passportNumber,
          dateOfBirth: p.dateOfBirth,
          nationality: p.nationality,
          passengerType: 'ADULT',
        })),
      });
      clear();
      Taro.redirectTo({ url: `/pages/order-detail/index?id=${order.id}` });
    } catch (e) {
      Taro.showToast({
        title: e instanceof ApiError ? e.message : '下单失败',
        icon: 'none',
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (items.length === 0) {
    return (
      <View className='checkout-page empty'>
        <Text>购物车为空，请先加购航班</Text>
        <View className='btn-primary' onClick={() => Taro.switchTab({ url: '/pages/index/index' })}>去首页</View>
      </View>
    );
  }

  return (
    <ScrollView className='checkout-page' scrollY>
      {/* 订单明细 */}
      <View className='card'>
        <Text className='section-title'>订单明细</Text>
        {items.map((i, idx) => (
          <View key={idx} className='line'>
            <Text className='line-name'>{i.name}</Text>
            <Text className='line-price'>¥{(i.unitPrice * i.qty).toLocaleString()}</Text>
          </View>
        ))}
        <View className='total-row'>
          <Text>合计</Text>
          <Text className='text-price big'>¥{total.toLocaleString()}</Text>
        </View>
      </View>

      {/* 联系人 */}
      <View className='card'>
        <Text className='section-title'>联系人信息</Text>
        <Text className='label'>姓名</Text>
        <Input className='input' value={contactName} onInput={(e) => setContactName(e.detail.value)} />
        <Text className='label'>电话</Text>
        <Input type='number' className='input' value={contactPhone} onInput={(e) => setContactPhone(e.detail.value)} />
        <Text className='label'>邮箱（可选）</Text>
        <Input className='input' value={contactEmail} onInput={(e) => setContactEmail(e.detail.value)} />
      </View>

      {/* 乘客 */}
      <View className='card'>
        <View className='section-head'>
          <Text className='section-title'>出行人（{passengers.length} 人）</Text>
          <Text className='link' onClick={addPassenger}>+ 添加</Text>
        </View>
        {paxMismatch && (
          <View className='warning'>
            ⚠ 机票 {flightQty} 张，需填 {flightQty} 位乘客，当前 {passengers.length} 位
          </View>
        )}
        {passengers.map((p, idx) => (
          <View key={idx} className='passenger'>
            <View className='passenger-head'>
              <Text className='passenger-n'>第 {idx + 1} 位</Text>
              {passengers.length > 1 && (
                <Text className='del' onClick={() => removePassenger(idx)}>删除</Text>
              )}
            </View>
            <Text className='label'>姓名（拼音，与护照一致）</Text>
            <Input className='input' value={p.fullName} onInput={(e) => updatePassenger(idx, { fullName: e.detail.value })} />
            <Text className='label'>护照号</Text>
            <Input className='input' value={p.passportNumber} onInput={(e) => updatePassenger(idx, { passportNumber: e.detail.value.toUpperCase() })} />
            <Text className='label'>出生日期（YYYY-MM-DD）</Text>
            <Input className='input' value={p.dateOfBirth} placeholder='1990-01-01' onInput={(e) => updatePassenger(idx, { dateOfBirth: e.detail.value })} />
          </View>
        ))}
      </View>

      <View
        className={`btn-primary submit ${submitting || paxMismatch ? 'disabled' : ''}`}
        onClick={submit}
      >
        {submitting ? '提交中…' : `提交订单 · ¥${total.toLocaleString()}`}
      </View>
    </ScrollView>
  );
}
