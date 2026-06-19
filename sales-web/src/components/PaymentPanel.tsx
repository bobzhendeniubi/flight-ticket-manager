/**
 * 收款方式 + 上传付款凭证（椰岛 · 消费者侧）
 *
 * 下单后买家在此看到：
 *   - 统一收款码（微信 / 支付宝 / 银行）+ 渠道名 + 账户文字 + 备注
 *   - 醒目的「应付金额」
 *   - 简短指引：付款后上传凭证，客服会尽快核对到账
 *   - 「上传付款凭证」控件（选图 → data URL，过大自动压缩；可选金额/方式）
 *
 * 数据来源（公开端点，无需登录）：
 *   GET  /public/payment-channels        → 启用中的收款渠道
 *   POST /public/orders/upload-receipt   → 凭「订单号 + lookupKey」建一条待对账凭证
 *
 * 重要口径：上传仅是「认领」，到账由财务人工核对后才入账 —— 前端不据此改订单状态。
 */
import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type PaymentChannelKind,
  type PaymentMethod,
  type PublicPaymentChannel,
} from '../lib/api';
import { Icon } from './Icon';

/** 后端 data-URL 上限 6MB；前端预留余量，超过则压缩到此目标以内（含 base64 膨胀）。 */
const MAX_PROOF_BYTES = 6 * 1024 * 1024;
const COMPRESS_TARGET_BYTES = 4.5 * 1024 * 1024; // 压缩目标，留足上传余量
const MAX_IMAGE_DIMENSION = 2000; // 压缩时长边上限（px）

/** 渠道分组 → 中文名 + 主题色（椰岛色板）。 */
const KIND_META: Record<
  PaymentChannelKind,
  { label: string; chipBg: string; chipText: string }
> = {
  WECHAT: { label: '微信支付', chipBg: 'bg-palm-light', chipText: 'text-[#15613f]' },
  ALIPAY: { label: '支付宝', chipBg: 'bg-brand-50', chipText: 'text-brand-700' },
  BANK: { label: '银行转账', chipBg: 'bg-sand-light', chipText: 'text-amber-700' },
};

/** 付款方式（可选）映射到 PaymentMethod，供凭证标注用。 */
const METHOD_OPTIONS: Array<{ value: PaymentMethod; label: string }> = [
  { value: 'WECHAT_PAY', label: '微信支付' },
  { value: 'ALIPAY', label: '支付宝' },
  { value: 'BANK_CARD', label: '银行卡 / 转账' },
];

/** 金额渲染兜底：非法数值显示 '0' 而不是 NaN。 */
function fmtMoney(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString() : '0';
}

/**
 * 把图片文件读成 data URL；过大时用 canvas 等比压缩到目标体积以内。
 * 返回 data:image/...;base64,XXX；无法压到上限内则抛出可读错误。
 */
async function fileToProofDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('请上传图片格式的付款凭证（如截图 JPG / PNG）');
  }

  const rawDataUrl = await readAsDataUrl(file);
  // 小图直接用原图（避免无谓的二次编码 / 画质损失）
  if (rawDataUrl.length <= COMPRESS_TARGET_BYTES) return rawDataUrl;

  // 超目标 → 等比压缩
  const compressed = await compressDataUrl(rawDataUrl);
  if (compressed.length > MAX_PROOF_BYTES) {
    throw new Error('图片过大且压缩后仍超出限制，请换一张更小的截图');
  }
  return compressed;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('读取图片失败，请重试'));
    reader.onerror = () => reject(new Error('读取图片失败，请重试'));
    reader.readAsDataURL(file);
  });
}

/** canvas 等比缩放 + 降质重编码为 JPEG，逼近目标体积。 */
async function compressDataUrl(dataUrl: string): Promise<string> {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl; // 无 2d 上下文（极端环境）→ 退回原图，由上限校验兜底
  ctx.drawImage(img, 0, 0, w, h);

  // 逐步降质直到达标（或到下限画质）
  for (const quality of [0.82, 0.7, 0.58, 0.45]) {
    const out = canvas.toDataURL('image/jpeg', quality);
    if (out.length <= COMPRESS_TARGET_BYTES) return out;
  }
  return canvas.toDataURL('image/jpeg', 0.45);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解析失败，请换一张'));
    img.src = src;
  });
}

interface PaymentPanelProps {
  /** 订单号（用于上传凭证校验）。 */
  orderNo: string;
  /**
   * 查单凭据：下单手机号 / 邮箱 / 联系人姓氏（与公开查单同口径）。
   * 上传时随订单号一起发给后端做匹配校验。
   */
  lookupKey: string;
  /** 应付金额（CNY）；醒目展示，也作为上传金额的默认值。 */
  amountDueCny: number;
  /** 视觉变体：'success' 用于下单成功页（更突出）；'detail' 用于订单详情内嵌。 */
  variant?: 'success' | 'detail';
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'done'; receiptNo: string }
  | { kind: 'error'; message: string };

export function PaymentPanel({
  orderNo,
  lookupKey,
  amountDueCny,
  variant = 'detail',
}: PaymentPanelProps) {
  const [channels, setChannels] = useState<PublicPaymentChannel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  const isSuccess = variant === 'success';

  return (
    <section
      className={`overflow-hidden rounded-2xl border bg-surface text-left shadow-card ${
        isSuccess ? 'border-brand-200' : 'border-slate-200/80'
      }`}
      aria-labelledby={`pay-heading-${orderNo}`}
    >
      {/* 头部：海洋渐变条 + 应付金额 */}
      <header className="bg-gradient-to-br from-brand-50 to-lagoon-light px-5 py-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2
              id={`pay-heading-${orderNo}`}
              className="flex items-center gap-1.5 text-base font-extrabold tracking-tight text-ink"
            >
              <Icon name="ticket" className="h-4 w-4 text-brand-700" /> 收款方式
            </h2>
            <p className="mt-0.5 text-xs text-ink-soft">
              扫码或转账完成支付，再上传凭证即可
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs font-medium text-ink-muted">应付金额</div>
            <div className="price text-2xl leading-none sm:text-3xl">
              ¥{fmtMoney(amountDueCny)}
            </div>
          </div>
        </div>
      </header>

      <div className="space-y-4 px-5 py-4">
        {/* 收款渠道 */}
        {loadError && (
          <p className="flex items-start gap-2 rounded-xl border border-sun/40 bg-sun-light px-3.5 py-2.5 text-sm font-medium text-amber-800">
            <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0" />
            收款方式暂时无法加载（{loadError}）。请稍后刷新，或直接联系客服获取收款信息。
          </p>
        )}

        {!loadError && channels === null && (
          <div className="grid gap-3 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="skeleton h-40" />
            ))}
          </div>
        )}

        {!loadError && channels !== null && channels.length === 0 && (
          <p className="flex items-start gap-2 rounded-xl border border-slate-200 bg-canvas px-3.5 py-2.5 text-sm text-ink-soft">
            <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" />
            暂未配置在线收款方式，客服会与你联系并提供收款信息。你仍可在下方上传转账凭证。
          </p>
        )}

        {channels !== null && channels.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2">
            {channels.map((ch) => (
              <ChannelCard key={ch.id} channel={ch} />
            ))}
          </ul>
        )}

        {/* 上传凭证 */}
        <ReceiptUploader
          orderNo={orderNo}
          lookupKey={lookupKey}
          amountDueCny={amountDueCny}
        />

        {/* 人工核对声明（诚实口径） */}
        <p className="flex items-start gap-1.5 rounded-xl bg-canvas px-3.5 py-2.5 text-xs text-ink-muted">
          <Icon name="shield" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-400" />
          付款后上传凭证，客服会尽快为你核对到账。到账为人工核对，确认后订单状态才会更新，请耐心等候。
        </p>
      </div>
    </section>
  );
}

/** 单个收款渠道卡：收款码图 + 渠道名 + 账户文字 + 备注。 */
function ChannelCard({ channel }: { channel: PublicPaymentChannel }) {
  const meta = KIND_META[channel.kind] ?? KIND_META.BANK;
  return (
    <li className="flex flex-col rounded-2xl border border-slate-200/80 bg-canvas p-3.5 transition hover:border-brand/30">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="font-semibold text-ink">{channel.label}</span>
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${meta.chipBg} ${meta.chipText}`}
        >
          {meta.label}
        </span>
      </div>

      {channel.qrImageUrl ? (
        <div className="mx-auto rounded-xl border border-slate-200 bg-white p-2">
          <img
            src={channel.qrImageUrl}
            alt={`${channel.label} 收款码`}
            width={176}
            height={176}
            loading="lazy"
            className="h-44 w-44 object-contain"
          />
        </div>
      ) : (
        <div className="flex h-44 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white text-xs text-ink-muted">
          请使用下方账户信息转账
        </div>
      )}

      {channel.accountText && (
        <p className="mt-2.5 whitespace-pre-wrap break-words rounded-lg bg-white px-2.5 py-2 text-xs leading-relaxed text-ink-soft">
          {channel.accountText}
        </p>
      )}
      {channel.note && (
        <p className="mt-1.5 flex items-start gap-1 text-xs text-ink-muted">
          <Icon name="info" className="mt-0.5 h-3 w-3 shrink-0" />
          {channel.note}
        </p>
      )}
    </li>
  );
}

/** 上传付款凭证控件：选图（自动压缩）+ 可选金额/方式 → POST upload-receipt。 */
function ReceiptUploader({
  orderNo,
  lookupKey,
  amountDueCny,
}: {
  orderNo: string;
  lookupKey: string;
  amountDueCny: number;
}) {
  const [proofDataUrl, setProofDataUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  // 金额输入：默认带上应付金额（买家全额付时无需手动改）；可清空让财务核定。
  const [amountInput, setAmountInput] = useState<string>(
    Number.isFinite(amountDueCny) && amountDueCny > 0 ? String(amountDueCny) : '',
  );
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' });

  const handleFile = async (file: File) => {
    setFileError(null);
    setProcessing(true);
    try {
      const dataUrl = await fileToProofDataUrl(file);
      setProofDataUrl(dataUrl);
    } catch (e) {
      setProofDataUrl(null);
      setFileError(e instanceof Error ? e.message : '图片处理失败，请重试');
    } finally {
      setProcessing(false);
    }
  };

  const canSubmit =
    Boolean(proofDataUrl) && !processing && submit.kind !== 'submitting';

  const onSubmit = async () => {
    if (!proofDataUrl) {
      setFileError('请先选择付款凭证图片');
      return;
    }
    // 金额选填：填了就校验为正数
    let amountCny: number | undefined;
    if (amountInput.trim()) {
      const n = Number(amountInput);
      if (!Number.isFinite(n) || n <= 0) {
        setSubmit({ kind: 'error', message: '付款金额需为大于 0 的数字' });
        return;
      }
      amountCny = n;
    }

    setSubmit({ kind: 'submitting' });
    try {
      const res = await api.uploadOrderReceipt({
        orderNo,
        lookupKey,
        proofUrl: proofDataUrl,
        ...(amountCny !== undefined ? { amountCny } : {}),
        ...(method ? { method } : {}),
      });
      setSubmit({ kind: 'done', receiptNo: res.receiptNo });
    } catch (e) {
      let message = '提交失败，请重试';
      if (e instanceof ApiError) {
        // 404 = 订单号 / 凭据不匹配；其余沿用后端文案
        message =
          e.status === 404
            ? '未匹配到订单，请核对订单号与下单手机号 / 邮箱后重试'
            : e.message;
      } else if (e instanceof Error) {
        message = e.message;
      }
      setSubmit({ kind: 'error', message });
    }
  };

  // 成功态：替换上传区为确认提示
  if (submit.kind === 'done') {
    return (
      <div className="rounded-2xl border border-palm/40 bg-palm-light px-4 py-3.5 text-sm text-[#15613f]">
        <p className="flex items-center gap-1.5 font-semibold">
          <Icon name="check" className="h-4 w-4" /> 凭证已提交，客服核对中
        </p>
        <p className="mt-1 text-xs text-[#1f8a5b]">
          凭证编号 <span className="font-mono font-semibold">{submit.receiptNo}</span>
          。到账以人工核对为准，确认后订单状态会更新。
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-canvas p-4">
      <h3 className="flex items-center gap-1.5 text-sm font-bold text-ink">
        <Icon name="check" className="h-4 w-4 text-brand-700" /> 上传付款凭证
      </h3>
      <p className="mt-0.5 text-xs text-ink-muted">
        付款后上传截图，客服会尽快为你核对到账。
      </p>

      {/* 选图区 */}
      <div className="mt-3 flex flex-wrap items-start gap-3">
        <label className="group flex h-24 w-24 shrink-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-slate-300 bg-white text-center text-xs text-ink-muted transition hover:border-brand/50 hover:bg-brand-50/40">
          {processing ? (
            <span className="text-brand-700">处理中…</span>
          ) : proofDataUrl ? (
            <img
              src={proofDataUrl}
              alt="付款凭证预览"
              className="h-full w-full rounded-[10px] object-cover"
            />
          ) : (
            <>
              <Icon name="ticket" className="h-5 w-5 text-brand-400 transition group-hover:text-brand-600" />
              <span>选择截图</span>
            </>
          )}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            disabled={processing || submit.kind === 'submitting'}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              // 允许重复选同一文件
              e.target.value = '';
            }}
          />
        </label>

        {/* 金额（选填）+ 方式（选填） */}
        <div className="min-w-[180px] flex-1 space-y-2.5">
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-soft" htmlFor={`amt-${orderNo}`}>
              付款金额（选填）
            </label>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold text-ink-muted">¥</span>
              <input
                id={`amt-${orderNo}`}
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                className="input flex-1 py-2"
                placeholder="如全额付款可留默认"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink-soft" htmlFor={`method-${orderNo}`}>
              付款方式（选填）
            </label>
            <select
              id={`method-${orderNo}`}
              className="input py-2"
              value={method}
              onChange={(e) => setMethod(e.target.value as PaymentMethod | '')}
            >
              <option value="">不指定</option>
              {METHOD_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {fileError && (
        <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-deal">
          <Icon name="info" className="h-3.5 w-3.5 shrink-0" /> {fileError}
        </p>
      )}
      {submit.kind === 'error' && (
        <p className="mt-2 flex items-center gap-1.5 rounded-lg border border-deal/30 bg-deal-light px-3 py-2 text-xs font-medium text-deal-dark" role="alert">
          <Icon name="info" className="h-3.5 w-3.5 shrink-0" /> {submit.message}
        </p>
      )}

      <button
        type="button"
        onClick={onSubmit}
        disabled={!canSubmit}
        className="btn-primary mt-3 w-full sm:w-auto"
      >
        {submit.kind === 'submitting' ? '提交中…' : '提交付款凭证'}
      </button>
    </div>
  );
}
