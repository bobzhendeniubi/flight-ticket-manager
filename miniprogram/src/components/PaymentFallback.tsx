/**
 * 线下收款兜底面板（F-6）—— 小程序在线支付（微信 JSAPI 预下单）失败或未开通时展示。
 *
 * 照 sales-web/src/components/PaymentPanel.tsx 的做法，用同一套公开端点：
 *   GET  /public/payment-channels        → 启用中的收款渠道（收款码 + 账户文字 + 备注）
 *   POST /public/orders/upload-receipt   → 凭「订单号 + lookupKey」建一条待对账凭证
 *
 * 与 sales-web 的差异（Taro 无 DOM）：
 *   - 选图用 Taro.chooseImage，不是 <input type="file">
 *   - 没有 FileReader/canvas，直接用 Taro.getFileSystemManager().readFileSync(path, 'base64')
 *     拼 data URL；小程序端图片本就经过系统相册/相机压缩，不做二次压缩，超限交给后端校验。
 *
 * 重要口径同 sales-web：上传仅是「认领」，到账由财务人工核对后才入账，本组件不据此改订单状态。
 */
import { useEffect, useState } from 'react';
import Taro from '@tarojs/taro';
import { View, Text, Image } from '@tarojs/components';
import { api, ApiError } from '../lib/api';
import type { PaymentChannelKind, PublicPaymentChannel } from '../lib/types';
import './PaymentFallback.scss';

const KIND_LABEL: Record<PaymentChannelKind, string> = {
  WECHAT: '微信支付',
  ALIPAY: '支付宝',
  BANK: '银行转账',
};

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'done'; receiptNo: string }
  | { kind: 'error'; message: string };

interface PaymentFallbackProps {
  /** 订单号（上传凭证校验用）。 */
  orderNo: string;
  /** 查单凭据：下单手机号 / 邮箱 / 联系人姓氏（与公开查单同口径），这里固定传订单联系电话。 */
  lookupKey: string;
  /** 应付金额（CNY），用于展示与默认上传金额；≤0（已结清）时不预填金额，交财务核定。 */
  amountDueCny: number;
}

/** 金额展示兜底：非法数值显示 '0' 而不是 NaN。 */
function fmtMoney(v: number): string {
  return Number.isFinite(v) ? v.toLocaleString() : '0';
}

export function PaymentFallback({ orderNo, lookupKey, amountDueCny }: PaymentFallbackProps) {
  const [channels, setChannels] = useState<PublicPaymentChannel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [proofDataUrl, setProofDataUrl] = useState<string | null>(null);
  const [chooseError, setChooseError] = useState<string | null>(null);
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' });

  useEffect(() => {
    let alive = true;
    api
      .getPublicPaymentChannels()
      .then((r) => {
        if (alive) setChannels(r.channels);
      })
      .catch((e) => {
        if (alive) setLoadError(e instanceof Error ? e.message : '收款方式加载失败');
      });
    return () => {
      alive = false;
    };
  }, []);

  const chooseProof = async () => {
    setChooseError(null);
    try {
      const res = await Taro.chooseImage({ count: 1, sizeType: ['compressed'] });
      const path = res.tempFilePaths?.[0];
      if (!path) return;
      // 小程序无 File/FileReader —— 直接用文件系统管理器把临时文件读成 base64 拼 data URL
      const fsm = Taro.getFileSystemManager();
      const base64 = fsm.readFileSync(path, 'base64') as string;
      const ext = path.split('.').pop()?.toLowerCase();
      const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
      setProofDataUrl(`data:${mime};base64,${base64}`);
      setSubmit({ kind: 'idle' });
    } catch (e) {
      // 用户取消选择图片时 Taro 也会走 catch —— 只在有实际 errMsg 时提示，避免误报「失败」
      const msg = (e as { errMsg?: string })?.errMsg ?? '';
      if (msg.includes('cancel')) return;
      setChooseError('选择图片失败，请重试');
    }
  };

  const onSubmit = async () => {
    if (!proofDataUrl) {
      setSubmit({ kind: 'error', message: '请先选择付款凭证截图' });
      return;
    }
    setSubmit({ kind: 'submitting' });
    try {
      const res = await api.uploadOrderReceipt({
        orderNo,
        lookupKey,
        proofUrl: proofDataUrl,
        ...(amountDueCny > 0 ? { amountCny: amountDueCny } : {}),
      });
      setSubmit({ kind: 'done', receiptNo: res.receiptNo });
    } catch (e) {
      const message =
        e instanceof ApiError
          ? e.status === 404
            ? '未匹配到订单，请核对订单号与联系方式后重试'
            : e.message
          : '提交失败，请重试';
      setSubmit({ kind: 'error', message });
    }
  };

  if (submit.kind === 'done') {
    return (
      <View className='payment-fallback done'>
        <Text className='done-title'>凭证已提交，客服核对中</Text>
        <Text className='done-sub'>
          凭证编号 {submit.receiptNo}。到账以人工核对为准，确认后订单状态会更新。
        </Text>
      </View>
    );
  }

  return (
    <View className='payment-fallback card'>
      <Text className='section-title'>线下收款</Text>
      <Text className='hint'>线上支付暂不可用，请使用以下方式转账，转账后上传凭证</Text>

      {loadError && <Text className='error'>收款方式加载失败（{loadError}），请直接联系客服获取收款信息</Text>}
      {!loadError && channels === null && <Text className='hint'>收款方式加载中…</Text>}
      {!loadError && channels !== null && channels.length === 0 && (
        <Text className='hint'>暂未配置在线收款方式，客服会与你联系并提供收款信息，你也可以先在下方上传转账凭证</Text>
      )}

      {channels !== null &&
        channels.map((ch) => (
          <View key={ch.id} className='channel'>
            <View className='channel-head'>
              <Text className='channel-label'>{ch.label}</Text>
              <Text className='channel-kind'>{KIND_LABEL[ch.kind]}</Text>
            </View>
            {ch.qrImageUrl ? (
              <Image className='qr' src={ch.qrImageUrl} mode='aspectFit' />
            ) : (
              <View className='qr qr-empty'>
                <Text>请使用下方账户信息转账</Text>
              </View>
            )}
            {ch.accountText && <Text className='account-text'>{ch.accountText}</Text>}
            {ch.note && <Text className='note'>{ch.note}</Text>}
          </View>
        ))}

      <View className='uploader'>
        <Text className='section-title small'>上传付款凭证</Text>
        <Text className='hint'>付款后上传截图，客服会尽快为你核对到账（应付 ¥{fmtMoney(amountDueCny)}）</Text>

        <View className='choose-box' onClick={chooseProof}>
          {proofDataUrl ? (
            <Image className='preview' src={proofDataUrl} mode='aspectFill' />
          ) : (
            <Text className='choose-label'>选择截图</Text>
          )}
        </View>

        {chooseError && <Text className='error'>{chooseError}</Text>}
        {submit.kind === 'error' && <Text className='error'>{submit.message}</Text>}

        <View
          className={`btn-primary submit-btn ${!proofDataUrl || submit.kind === 'submitting' ? 'disabled' : ''}`}
          onClick={!proofDataUrl || submit.kind === 'submitting' ? undefined : onSubmit}
        >
          {submit.kind === 'submitting' ? '提交中…' : '提交付款凭证'}
        </View>
      </View>

      <Text className='disclaimer'>付款后上传凭证，客服会尽快为你核对到账。到账为人工核对，确认后订单状态才会更新，请耐心等候。</Text>
    </View>
  );
}
