/**
 * 结账页 — 联系信息 + 乘客信息（张数=乘客数强制校验）+ 创建订单。
 *
 * 简化版（vs sales-web）：
 *   - 没有 OCR（小程序端 tesseract 太重，未来接后台真 OCR）
 *   - 只支持 WECHAT_PAY 方式
 *   - 创建订单成功后跳转到订单详情 → 付款按钮触发 wx.requestPayment
 */
import { useEffect, useState } from 'react';
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
  /**
   * 证件有效期 YYYY-MM-DD —— 必填。小程序购物车只提交机票行（按人出行产品），
   * 后端下单接口对这类单同款拦截，所以这里无条件必填。
   */
  passportExpiry: string;
  nationality: string;
}

const EMPTY: PassengerForm = {
  fullName: '',
  passportNumber: '',
  dateOfBirth: '',
  passportExpiry: '',
  nationality: 'CN',
};

/** 日期格式：YYYY-MM-DD（与后端同款正则） */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 证件有效期提醒：不足 6 个月 / 已过期给一句黄字提示（同 H5 端口径）。
 * 只提醒、不拦截 —— 各目的地入境要求不同，交由客服跟进。
 */
function expiryNotice(expiry: string): string | null {
  if (!DATE_RE.test(expiry)) return null;
  const end = new Date(`${expiry}T00:00:00`);
  if (Number.isNaN(end.getTime())) return null;
  const days = Math.floor((end.getTime() - Date.now()) / 86400000);
  if (days < 0) return '该证件已过期，请更换为在有效期内的证件';
  if (days < 180) return '有效期不足 6 个月，多数目的地要求 6 个月以上，建议先换发新证件';
  return null;
}

export default function CheckoutPage() {
  const { items, hydrate, hydrated, clear, ensureIdempotencyKey } = useCart();
  const { user, tokens, hydrate: hydrateAuth } = useAuth();

  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [passengers, setPassengers] = useState<PassengerForm[]>([{ ...EMPTY }]);
  const [submitting, setSubmitting] = useState(false);

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
    // 证件有效期必填：文案指到第几位出行人（后端同款拦截，这里先本地挡一道）
    const badExpiryIdx = passengers.findIndex((p) => !DATE_RE.test(p.passportExpiry.trim()));
    if (badExpiryIdx >= 0) {
      Taro.showToast({
        title: `请填写第 ${badExpiryIdx + 1} 位出行人的证件有效期（如 2031-01-01）`,
        icon: 'none',
      });
      return;
    }

    setSubmitting(true);
    // 从 store 拿持久化的 key（跨 remount / 导航 / 小程序重启仍稳定）
    // 只有 clear() 后才会换新 key —— 这样网络抖动导致的客户端重试永远用同一把锁
    const idempotencyKey = ensureIdempotencyKey();
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
          // 证件有效期：全渠道必填，提交前已按 YYYY-MM-DD 校验
          passportExpiry: p.passportExpiry.trim(),
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
            <Text className='label'>证件有效期（护照资料页「有效期至」，YYYY-MM-DD）</Text>
            <Input className='input' value={p.passportExpiry} placeholder='2031-01-01' onInput={(e) => updatePassenger(idx, { passportExpiry: e.detail.value })} />
            {expiryNotice(p.passportExpiry) && (
              <View className='warning'>{expiryNotice(p.passportExpiry)}</View>
            )}
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
