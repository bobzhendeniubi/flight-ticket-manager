/**
 * 订单详情 + 支付触发。
 *
 * 支付流程：
 *   1. 后端 POST /payments/wechat/miniapp-prepay → 拿 { timeStamp, nonceStr, package, signType, paySign }
 *   2. 前端 wx.requestPayment(params)
 *   3. 用户在微信里完成付款 → 微信回调 webhook → 订单状态 → PAID
 *   4. 本页轮询 2-3 次 /orders/:id 看状态变化
 *
 * Sandbox: 后端返的 prepay_id 是假的，wx.requestPayment 会 fail（fail 回调里继续走流程）。
 * 开发时用 admin 后台直接推订单到 PAID 验证联动。
 */
import { useEffect, useState, useCallback } from 'react';
import Taro from '@tarojs/taro';
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

export default function OrderDetailPage() {
  const { tokens, hydrate, hydrated } = useAuth();
  const [order, setOrder] = useState<OrderSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  useEffect(() => {
    if (!hydrated) hydrate();
  }, [hydrate, hydrated]);

  const orderId = Taro.getCurrentInstance().router?.params.id as string | undefined;

  const load = useCallback(async () => {
    if (!tokens || !orderId) return;
    setLoading(true);
    try {
      const r = await api.getOrder(tokens.accessToken, orderId);
      setOrder(r.order);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [tokens, orderId]);

  useEffect(() => { void load(); }, [load]);

  // 倒计时（只在 PENDING_PAYMENT 展示）
  useEffect(() => {
    if (!order || order.status !== 'PENDING_PAYMENT' || !order.paymentExpiresAt) return;
    const tick = () => {
      const left = new Date(order.paymentExpiresAt!).getTime() - Date.now();
      setCountdown(Math.max(0, Math.floor(left / 1000)));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [order]);

  const pay = async () => {
    if (!order || !tokens) return;
    setPaying(true);
    try {
      const params = await api.wechatMiniappPrepay(tokens.accessToken, order.id);
      // 调微信支付
      await new Promise<void>((resolve, reject) => {
        Taro.requestPayment({
          timeStamp: params.timeStamp,
          nonceStr: params.nonceStr,
          package: params.package,
          signType: params.signType as 'RSA' | 'MD5' | 'HMAC-SHA256',
          paySign: params.paySign,
          success: () => resolve(),
          fail: (err: unknown) => reject(err),
        });
      });
      Taro.showToast({ title: '支付成功', icon: 'success' });
      // 等 webhook 更新状态后刷新
      setTimeout(load, 1500);
      setTimeout(load, 4000);
    } catch (e) {
      // sandbox 下 wx.requestPayment 一定失败；这是预期的
      const msg = (e as { errMsg?: string })?.errMsg ?? '支付失败或已取消';
      Taro.showToast({
        title: msg.includes('cancel') ? '已取消支付' : msg,
        icon: 'none',
      });
    } finally {
      setPaying(false);
    }
  };

  if (loading || !order) {
    return <View className='order-detail-page empty'>{error ?? '加载中…'}</View>;
  }

  const st = STATUS_LABEL[order.status] ?? STATUS_FALLBACK;
  const mm = countdown !== null ? Math.floor(countdown / 60) : null;
  const ss = countdown !== null ? countdown % 60 : null;

  return (
    <ScrollView className='order-detail-page' scrollY>
      {/* 状态横幅 */}
      <View className='status-banner' style={{ background: st.color }}>
        <Text className='status-title'>{st.label}</Text>
        {order.status === 'PENDING_PAYMENT' && countdown !== null && (
          <Text className='sub'>
            {countdown > 0
              ? `座位保留中 · ${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
              : '支付超时，座位已释放'}
          </Text>
        )}
        {order.status === 'PENDING_PAYMENT' && !order.paymentExpiresAt && (
          <Text className='sub'>座位已锁定 · 线下结算 · 不限时</Text>
        )}
      </View>

      <View className='card'>
        <View className='line'>
          <Text className='k'>订单号</Text>
          <Text className='v mono'>{order.orderNumber}</Text>
        </View>
        <View className='line'>
          <Text className='k'>下单时间</Text>
          <Text className='v'>{order.createdAt.slice(0, 19).replace('T', ' ')}</Text>
        </View>
        <View className='line'>
          <Text className='k'>联系人</Text>
          <Text className='v'>{order.contactName} · {order.contactPhone}</Text>
        </View>
      </View>

      <View className='card'>
        <Text className='section-title'>产品明细</Text>
        {order.items.map((it) => (
          <View key={it.id} className='line'>
            <Text className='k flex'>{it.description}</Text>
            <Text className='v'>¥{Number(it.amount).toLocaleString()}</Text>
          </View>
        ))}
        <View className='line total'>
          <Text className='k'>合计</Text>
          <Text className='text-price big'>¥{Number(order.total).toLocaleString()}</Text>
        </View>
      </View>

      <View className='card'>
        <Text className='section-title'>乘客 ({order.passengers.length} 人)</Text>
        {order.passengers.map((p) => (
          <View key={p.id} className='passenger'>
            <Text className='p-name'>{p.fullName}</Text>
            <Text className='p-passport'>{p.documentNumber}</Text>
            {p.pnr && <Text className='p-pnr'>PNR: <Text className='mono'>{p.pnr}</Text></Text>}
            {p.eticketNumber && <Text className='p-pnr'>E-Ticket: <Text className='mono'>{p.eticketNumber}</Text></Text>}
          </View>
        ))}
      </View>

      {order.status === 'PENDING_PAYMENT' && countdown !== null && countdown > 0 && (
        <View
          className={`btn-primary pay ${paying ? 'disabled' : ''}`}
          onClick={paying ? undefined : pay}
        >
          {paying ? '支付中…' : `立即支付 ¥${Number(order.total).toLocaleString()}`}
        </View>
      )}

      {/* 取消订单 — PAID/PROCESSING/TICKETED 状态可申请，按规则计算手续费 */}
      {(order.status === 'PAID' || order.status === 'PROCESSING' || order.status === 'TICKETED') && (
        <View
          className='btn-secondary cancel-btn'
          onClick={async () => {
            if (!tokens || !orderId) return;
            try {
              const { quote } = await api.refundQuote(tokens.accessToken, orderId);
              const text = quote.items
                .map((i) => `${i.kind}: ¥${i.amount} → 退 ¥${i.refundAmount} (扣 ${i.feePercent}%)`)
                .join('\n');
              Taro.showModal({
                title: `预计退款 ¥${quote.totalRefund}`,
                content: `已付 ¥${quote.paidAmount}，手续费 ¥${quote.totalFee}\n\n${text}\n\n确认申请取消？`,
                confirmText: '确认取消',
                cancelText: '再想想',
                success: async (r) => {
                  if (!r.confirm) return;
                  try {
                    await api.cancelOrder(tokens.accessToken, orderId, '用户在小程序申请取消');
                    Taro.showToast({ title: '已申请取消，等待审批', icon: 'success' });
                    setTimeout(load, 500);
                  } catch (e) {
                    Taro.showToast({
                      title: e instanceof ApiError ? e.message : '取消失败',
                      icon: 'none',
                    });
                  }
                },
              });
            } catch (e) {
              Taro.showToast({
                title: e instanceof ApiError ? e.message : '查询退款金额失败',
                icon: 'none',
              });
            }
          }}
        >
          申请取消订单
        </View>
      )}

      {order.status === 'REFUND_REQUESTED' && (
        <View className='card refund-status'>
          <Text>⏳ 已提交取消申请，等待客服审批退款</Text>
        </View>
      )}
    </ScrollView>
  );
}
