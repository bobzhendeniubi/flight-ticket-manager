/**
 * 结账页 — 输入乘客信息（姓名、护照号、电话），可上传护照走 tesseract.js OCR 自动填表。
 *
 * 下单流程：POST /orders → 服务端重算价格 + 扣座位 + 生成订单号 → 跳完成页。
 */
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCart, KIND_INFO, isSelected } from '../stores/cart';
import { useAuth } from '../stores/auth';
import { usePassengers } from '../stores/passengers';
import { ocrPassport } from '../lib/passportOcr';
import { api, ApiError, type CreateOrderInput } from '../lib/api';
import { safeRandomUUID } from '../lib/uuid';
import { BookingNotices } from '../components/BookingNotices';

interface PassengerForm {
  fullName: string;
  passportNumber: string;
  phone: string;
  dateOfBirth: string;
  nationality: string;
}

const EMPTY_PASSENGER: PassengerForm = {
  fullName: '',
  passportNumber: '',
  phone: '',
  dateOfBirth: '',
  nationality: 'CN',
};

/** 金额渲染兜底：非法数值显示 '0' 而不是 NaN（白屏类反馈的修复之一） */
function fmt(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString() : '0';
}

// Real OCR 走 Tesseract.js（chi_sim + eng 语言包 + MRZ 解析）
// 见 lib/passportOcr.ts

export function CheckoutPage() {
  const user = useAuth((s) => s.user);
  const tokens = useAuth((s) => s.tokens);
  const isAgent = user?.role === 'AGENT';
  // 只结算购物车里"勾选"的产品（CartPage 勾选 → 这里结算 → 成功后只移除已结的）
  // 不能在 zustand 选择器里 filter：每次返回新数组会让 React 18 的快照一致性
  // 检查死循环（Maximum update depth exceeded → 整页白屏）。
  const allItems = useCart((s) => s.items);
  const items = useMemo(() => allItems.filter(isSelected), [allItems]);
  const total = items.reduce((sum, i) => sum + (Number(i.unitPrice) * Number(i.qty) || 0), 0);
  const removeMany = useCart((s) => s.removeMany);
  const clearPassengers = usePassengers((s) => s.clear);

  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  // 5/20 反馈：客人特殊要求（如先办批文、酒店单过海关）
  const [orderNotes, setOrderNotes] = useState('');
  // 初始化 passengers：如果 AI 助手在聊天里 OCR 过护照，从 sessionStorage 拉出来预填
  // （usePassengers 的 hydrate 已在 AiAssistant 里跑过；这里再 hydrate 一次拿最新值）
  const [passengers, setPassengers] = useState<PassengerForm[]>(() => {
    try {
      const raw = sessionStorage.getItem('ai_pending_passengers');
      if (raw) {
        const ocrList = JSON.parse(raw) as Array<{
          fullName: string;
          passportNumber: string;
          dateOfBirth?: string;
          nationality?: string;
        }>;
        if (ocrList.length > 0) {
          return ocrList.map((p) => ({
            fullName: p.fullName ?? '',
            passportNumber: p.passportNumber ?? '',
            phone: '',
            dateOfBirth: p.dateOfBirth ?? '',
            nationality: p.nationality ?? 'CN',
          }));
        }
      }
    } catch { /* noop */ }
    return [{ ...EMPTY_PASSENGER }];
  });
  const [paymentMethod, setPaymentMethod] = useState<CreateOrderInput['paymentMethod']>('WECHAT_PAY');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [done, setDone] = useState<{
    orderNumber: string;
    total: string;
    paymentExpiresAt: string | null;
  } | null>(null);

  // 幂等 key：整个结账会话一个，重试 / 重提交复用（防止双击造两单）
  // useMemo 只跑一次；重新下单（done 后换页）会自然创建新组件 → 新 key
  // safeRandomUUID：crypto.randomUUID() 在裸 IP http 走 insecure context 时会抛
  // DOMException，曾导致 CheckoutPage 白屏（5/31 反馈）
  const idempotencyKey = useMemo(() => safeRandomUUID(), []);

  // 需要出行人的总人数 = 一次行程的最多人数
  // 关键：往返机票会有 2 个 FLIGHT items（去程 + 回程），都是同一批人 ——
  // 所以取 MAX 不取 SUM，否则 2 人往返会要求 4 本护照
  const flightTicketCount = useMemo(
    () => {
      const flights = items.filter((i) => i.kind === 'FLIGHT');
      if (flights.length === 0) return 0;
      return Math.max(...flights.map((i) => Number(i.meta?.passengers) || i.qty));
    },
    [items],
  );
  const bundlePaxCount = items
    .filter((i) => i.kind === 'BUNDLE')
    .reduce((sum, i) => sum + (Number(i.meta?.pax) || 0), 0);
  // 签证/接送也是"按人"的产品 —— 只买签证/接送时同样要填出行人
  // （公测反馈：只买签证时出行人表单整个不出现，提交不了）
  const visaPaxCount = items
    .filter((i) => i.kind === 'VISA')
    .reduce((sum, i) => sum + (Number(i.qty) || 0), 0);
  const transferPaxCount = items
    .filter((i) => i.kind === 'TRANSFER')
    .reduce((sum, i) => sum + (Number(i.meta?.passengers) || Number(i.qty) || 0), 0);
  // 混买时取最大值（套餐含机票、签证/接送都是同一批出行人，取 MAX 不取 SUM）
  const effectivePax = Math.max(bundlePaxCount, flightTicketCount, visaPaxCount, transferPaxCount);
  const paxMismatch = effectivePax > 0 && passengers.length !== effectivePax;

  // 自动把出行人行数补齐到所需人数 —— 避免"少填一位 → 提交键灰着点不动"（前台反馈：下一步走不下去）
  useEffect(() => {
    if (effectivePax <= 0) return;
    setPassengers((prev) => {
      if (prev.length >= effectivePax) return prev;
      const pad = Array.from({ length: effectivePax - prev.length }, () => ({ ...EMPTY_PASSENGER }));
      return [...prev, ...pad];
    });
  }, [effectivePax]);

  if (items.length === 0 && !done) {
    return (
      <div className="card animate-fade-up py-16 text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-brand-50 text-5xl">🧳</div>
        <p className="mt-4 text-base font-semibold text-ink">购物车是空的</p>
        <p className="mt-1 text-sm text-ink-muted">先挑一份心仪的产品，再回来填资料下单</p>
        <Link to="/" className="btn-primary mt-5 inline-flex">
          先去挑产品 →
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="card mx-auto max-w-lg animate-fade-up py-12 text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-brand-50 text-5xl">🎉</div>
        <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-ink">下单成功</h1>
        <p className="mt-3 text-sm text-ink-muted">订单号</p>
        <p className="mt-1 inline-block rounded-xl bg-canvas px-4 py-1.5 font-mono text-lg font-semibold text-ink nums">
          {done.orderNumber}
        </p>
        <p className="mt-4 text-sm text-ink-soft">
          应付 <span className="price text-xl align-middle">¥{fmt(done.total)}</span>
        </p>
        {done.paymentExpiresAt && (
          <HoldCountdown expiresAt={done.paymentExpiresAt} />
        )}
        <p className="mt-4 text-sm text-ink-muted">
          订单已创建，状态为 <span className="badge-sun">待支付</span>。
          运营会在 10 分钟内确认，已发短信至 {contactPhone}
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link to="/" className="btn-secondary">
            返回首页
          </Link>
          <button className="btn-primary" onClick={() => setDone(null)}>
            再下一单
          </button>
        </div>
      </div>
    );
  }

  const updatePassenger = (idx: number, patch: Partial<PassengerForm>) => {
    setPassengers((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  const addPassenger = () => setPassengers((prev) => [...prev, { ...EMPTY_PASSENGER }]);
  const removePassenger = (idx: number) =>
    setPassengers((prev) => prev.filter((_, i) => i !== idx));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    // Invariant: 买几张票/套餐几人就填几个出行人
    if (effectivePax > 0 && passengers.length !== effectivePax) {
      setErrorMsg(
        `需要 ${effectivePax} 位出行人（${flightTicketCount > 0 ? `机票 ${flightTicketCount} 张` : ''}${bundlePaxCount > 0 ? ` 套餐 ${bundlePaxCount} 人` : ''}${visaPaxCount > 0 ? ` 签证 ${visaPaxCount} 人` : ''}${transferPaxCount > 0 ? ` 接送 ${transferPaxCount} 人` : ''}），当前填了 ${passengers.length} 位`,
      );
      return;
    }
    if (passengers.length === 0) {
      setErrorMsg('至少需要 1 位出行人');
      return;
    }
    if (passengers.some((p) => !p.fullName.trim() || !p.passportNumber.trim() || !p.dateOfBirth)) {
      setErrorMsg('请填写所有出行人的姓名、护照号和出生日期');
      return;
    }
    if (!contactName.trim() || !contactPhone.trim()) {
      setErrorMsg('请填写联系人姓名和手机号');
      return;
    }
    if (!tokens?.accessToken) {
      setErrorMsg('登录已失效，请重新登录后再下单');
      return;
    }

    // 购物车 → CreateOrderInput.items
    const body: CreateOrderInput = {
      contactName: contactName.trim(),
      contactPhone: contactPhone.trim(),
      contactEmail: contactEmail.trim() || undefined,
      notes: orderNotes.trim() || undefined,
      paymentMethod,
      passengers: passengers.map((p) => ({
        fullName: p.fullName.trim(),
        documentType: 'PASSPORT',
        documentNumber: p.passportNumber.trim(),
        dateOfBirth: p.dateOfBirth,
        nationality: p.nationality || 'CN',
        passengerType: 'ADULT',
      })),
      items: items.flatMap((i): CreateOrderInput['items'] => {
        if (i.kind === 'FLIGHT') {
          const qty = Number(i.meta?.passengers) || 1;
          const cabin = (String(i.meta?.cabin ?? 'ECONOMY')) as
            | 'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS' | 'FIRST';
          return [{
            kind: 'FLIGHT',
            description: i.name,
            quantity: qty,
            flightScheduleId: i.productId,
            flightCabin: cabin,
          }];
        }
        if (i.kind === 'HOTEL') {
          return [{
            kind: 'HOTEL',
            description: i.name,
            quantity: i.qty,
            unitPrice: i.unitPrice,
            checkIn: i.meta?.checkIn ? String(i.meta.checkIn) : undefined,
            checkOut: i.meta?.checkOut ? String(i.meta.checkOut) : undefined,
          }];
        }
        if (i.kind === 'TRANSFER') {
          return [{
            kind: 'TRANSFER',
            description: i.name,
            quantity: i.qty,
            unitPrice: i.unitPrice,
          }];
        }
        if (i.kind === 'VISA') {
          return [{
            kind: 'VISA',
            description: i.name,
            quantity: i.qty,
            unitPrice: i.unitPrice,
          }];
        }
        if (i.kind === 'BUNDLE') {
          // 把行程要素透传给后端 —— 后端据此写入套餐订单的酒店占房明细（房控板计入）
          const bundleMeta: Record<string, unknown> = {};
          if (i.meta?.goDate !== undefined) bundleMeta.goDate = i.meta.goDate;
          if (i.meta?.returnDate !== undefined) bundleMeta.returnDate = i.meta.returnDate;
          if (i.meta?.pax !== undefined) bundleMeta.pax = i.meta.pax;
          if (i.meta?.rooms !== undefined) bundleMeta.rooms = i.meta.rooms;
          return [{
            kind: 'BUNDLE',
            description: i.name,
            quantity: i.qty,
            unitPrice: i.unitPrice,
            bundleId: i.productId,
            ...(Object.keys(bundleMeta).length > 0 ? { metadata: bundleMeta } : {}),
          }];
        }
        return [];
      }),
      idempotencyKey,
    };

    const orderedIds = items.map((i) => i.id);
    setSubmitting(true);
    try {
      const { order } = await api.createOrder(tokens.accessToken, body);
      removeMany(orderedIds); // 只移除本次结算的产品，未勾选的留在购物车
      clearPassengers(); // 防止下单成功后下次开新单沿用旧 OCR 缓存（Codex P2 反馈）
      setDone({
        orderNumber: order.orderNumber,
        total: order.total,
        paymentExpiresAt: order.paymentExpiresAt ?? null,
      });
    } catch (err) {
      // 任何异常都要给用户可见反馈（公测反馈：失败时页面"卡住"无提示）
      if (err instanceof ApiError) {
        setErrorMsg(`下单失败：${err.message}`);
      } else {
        setErrorMsg(err instanceof Error ? err.message : '提交失败，请重试');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5 pb-28">
      <section className="animate-fade-up">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">确认订单</h1>
        <p className="section-sub">
          请填写联系人信息和每位乘客的护照信息。可上传护照照片自动识别（OCR）。
        </p>
        {errorMsg && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-deal/30 bg-deal-light px-4 py-3 text-sm font-medium text-deal-dark">
            <span aria-hidden>❌</span> <span>{errorMsg}</span>
          </div>
        )}
      </section>

      <form onSubmit={onSubmit} className="space-y-5">
        {/* 订单内容摘要 */}
        <section className="card">
          <h2 className="section-title text-base">订单内容</h2>
          <ul className="mt-4 divide-y divide-slate-100">
            {items.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2.5 text-sm first:pt-0">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-xl">{i.emoji}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${KIND_INFO[i.kind].color}`}
                >
                  {KIND_INFO[i.kind].label}
                </span>
                <span className="flex-1 truncate font-medium text-ink">{i.name}</span>
                <span className="text-ink-muted nums">× {i.qty}</span>
                <span className="w-20 text-right font-semibold text-ink nums">¥{fmt(i.unitPrice * i.qty)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between border-t border-slate-200/80 pt-3">
            <span className="text-sm text-ink-soft">合计</span>
            <span className="price text-2xl">¥{fmt(total)}</span>
          </div>
        </section>

        {/* 联系人 */}
        <section className="card">
          <h2 className="section-title text-base">联系人信息</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <div>
              <label className="label">姓名 *</label>
              <input
                className="input"
                required
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
              />
            </div>
            <div>
              <label className="label">手机号 *</label>
              <input
                className="input"
                required
                placeholder="如 +853 6234 5678"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
              />
            </div>
            <div>
              <label className="label">邮箱（选填）</label>
              <input
                type="email"
                className="input"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
              />
            </div>
            <div className="md:col-span-2">
              <label className="label">特殊说明（选填）</label>
              <textarea
                className="input"
                rows={2}
                placeholder="比如：需要提前拿到签证批文 + 酒店单过海关；或者有任何饮食/无障碍/接送需求"
                value={orderNotes}
                onChange={(e) => setOrderNotes(e.target.value)}
              />
              <p className="mt-1 text-xs text-ink-muted">
                运营会在订单详情里看到，按需安排。
              </p>
            </div>
          </div>
        </section>

        {/* 乘客 / 出行人 */}
        <section className="card">
          <div className="flex items-center justify-between gap-2">
            <h2 className="section-title text-base">
              出行人信息
              <span className="ml-1.5 align-middle text-sm font-medium text-ink-muted">
                {passengers.length} 人{effectivePax > 0 && ` / 需要 ${effectivePax} 人`}
              </span>
            </h2>
            <button type="button" className="btn-ghost px-3 py-1.5 text-sm text-brand-700 hover:text-brand-dark" onClick={addPassenger}>
              + 增加出行人
            </button>
          </div>
          <p className="mt-1 text-xs text-ink-muted">机票、签证按出行人开票/办证。每位都需提供护照信息。</p>
          {paxMismatch && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-sun/40 bg-sun-light px-4 py-3 text-sm font-medium text-amber-800">
              <span aria-hidden>⚠</span>
              <span>
                需要 {effectivePax} 位出行人，当前填了 {passengers.length} 位。
                请{passengers.length < effectivePax ? '增加出行人' : '减少出行人或返回购物车调整数量'}。
              </span>
            </div>
          )}

          <div className="mt-4 space-y-4">
            {passengers.map((p, idx) => (
              <PassengerCard
                key={idx}
                idx={idx}
                passenger={p}
                onChange={(patch) => updatePassenger(idx, patch)}
                onRemove={passengers.length > 1 ? () => removePassenger(idx) : undefined}
              />
            ))}
          </div>
        </section>

        {/* 支付方式 */}
        <section className="card">
          <h2 className="section-title text-base">支付方式</h2>
          <div className="mt-4 grid gap-2.5 md:grid-cols-2 lg:grid-cols-4">
            {[
              { v: 'WECHAT_PAY', label: '微信支付', emoji: '💚', show: true },
              { v: 'ALIPAY', label: '支付宝', emoji: '💙', show: true },
              { v: 'BANK_CARD', label: '信用卡', emoji: '💳', show: true },
              { v: 'AGENT_PREPAYMENT', label: '代理预付余额', emoji: '💰', show: isAgent },
            ].filter((p) => p.show).map((p) => (
              <label
                key={p.v}
                className={`cursor-pointer rounded-2xl border-2 p-3 text-center transition-all ${
                  paymentMethod === p.v
                    ? 'border-brand bg-brand-50 shadow-card'
                    : 'border-slate-200 hover:border-brand/40 hover:bg-brand-50/40'
                }`}
              >
                <input
                  type="radio"
                  className="sr-only"
                  name="payment"
                  value={p.v}
                  checked={paymentMethod === p.v}
                  onChange={(e) => setPaymentMethod(e.target.value as CreateOrderInput['paymentMethod'])}
                />
                <div className="text-2xl">{p.emoji}</div>
                <div className={`mt-1 text-sm font-semibold ${paymentMethod === p.v ? 'text-brand-700' : 'text-ink'}`}>{p.label}</div>
              </label>
            ))}
          </div>
          {paymentMethod === 'AGENT_PREPAYMENT' && isAgent && (
            <div className="mt-3 rounded-2xl border border-brand-200 bg-brand-50/60 px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium text-brand-800">代理预付余额（demo 模拟）</span>
                <span className="font-bold text-brand-700 nums">¥80,000.00</span>
              </div>
              <div className="mt-1.5 flex items-center justify-between text-xs text-brand-700">
                <span>本单抵扣</span>
                <span className="nums">−¥{fmt(total)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-xs text-brand-700">
                <span>支付后余额</span>
                <span className="nums">¥{fmt(80000 - total)}</span>
              </div>
              {total > 80000 && (
                <div className="mt-2 text-xs font-medium text-deal">⚠ 余额不足，请联系管理员充值或选择其他支付方式</div>
              )}
            </div>
          )}
        </section>

        {/* 预订须知 / 扣损规则 / 值机提示（纯展示，提交逻辑不动） */}
        <BookingNotices />

        {/* 手机端紧凑：返回 / 合计 + 按钮 在 360px 屏幕也不挤 */}
        <div className="sticky bottom-[calc(56px+env(safe-area-inset-bottom))] z-40 rounded-2xl border border-slate-200/80 bg-surface/95 px-3 py-3 shadow-pop backdrop-blur-xl sm:bottom-4 sm:px-4">
          <div className="flex items-center justify-between gap-2 sm:gap-4">
            <Link to="/cart" className="whitespace-nowrap text-xs font-medium text-ink-muted transition hover:text-brand-700 sm:text-sm">
              ← <span className="hidden sm:inline">返回</span>购物车
            </Link>
            <div className="flex flex-1 items-center justify-end gap-2 sm:flex-none sm:gap-4">
              <span className="whitespace-nowrap text-sm text-ink-soft sm:text-base">
                合计 <span className="price text-xl align-middle sm:text-2xl">¥{fmt(total)}</span>
              </span>
              <button type="submit" className="btn-deal whitespace-nowrap px-4 text-sm sm:px-6 sm:text-base" disabled={submitting}>
                {submitting ? '提交中…' : '提交订单'}
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

function PassengerCard({
  idx,
  passenger,
  onChange,
  onRemove,
}: {
  idx: number;
  passenger: PassengerForm;
  onChange: (patch: Partial<PassengerForm>) => void;
  onRemove?: () => void;
}) {
  const [ocring, setOcring] = useState(false);
  const [ocrStage, setOcrStage] = useState<{ pct: number; label: string } | null>(null);
  const [ocrResult, setOcrResult] = useState<{ ok: boolean; msg: string; preview?: string } | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  const handleOcr = async (file: File) => {
    setOcring(true);
    setOcrResult(null);

    // 图片预览
    const reader = new FileReader();
    reader.onload = (e) => setImagePreview(e.target?.result as string);
    reader.readAsDataURL(file);

    try {
      const result = await ocrPassport(file, (pct, label) => {
        setOcrStage({ pct, label });
      });

      if (result.success) {
        // 填入识别结果
        onChange({
          fullName: result.suggested.fullName || passenger.fullName,
          passportNumber: result.suggested.passportNumber || passenger.passportNumber,
          dateOfBirth: result.suggested.dateOfBirth || passenger.dateOfBirth,
          nationality: result.suggested.nationality || passenger.nationality,
        });
        setOcrResult({
          ok: true,
          msg: `✅ OCR 识别成功（${(result.elapsedMs / 1000).toFixed(1)}s · 置信度 ${result.confidence.toFixed(0)}%${result.mrz ? ' · MRZ 命中' : ''}）— 请核对关键字段`,
          preview: result.rawText.slice(0, 120),
        });
      } else {
        // 识别失败，但给出部分兜底结果
        if (result.fallback?.passportNumber || result.fallback?.chineseName) {
          onChange({
            fullName: result.fallback.englishName || result.fallback.chineseName || passenger.fullName,
            passportNumber: result.fallback.passportNumber || passenger.passportNumber,
            dateOfBirth: result.fallback.dateOfBirth || passenger.dateOfBirth,
          });
        }
        setOcrResult({
          ok: false,
          msg: '⚠️ OCR 部分识别（未匹配 MRZ 标准），请手工核对并补全字段',
          preview: result.rawText.slice(0, 120) || result.error,
        });
      }
    } catch (err) {
      setOcrResult({
        ok: false,
        msg: `❌ 识别失败：${err instanceof Error ? err.message : '未知错误'}。请手工填写。`,
      });
    } finally {
      setOcring(false);
      setOcrStage(null);
    }
  };

  return (
    <div className="rounded-2xl border border-slate-200/80 bg-canvas p-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold text-ink">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand-700 nums">{idx + 1}</span>
          出行人
        </h3>
        <div className="flex items-center gap-3">
          <label className="chip cursor-pointer text-brand-700 transition hover:bg-brand-50 hover:text-brand-dark">
            {ocring ? `识别中… ${ocrStage?.pct.toFixed(0) ?? 0}%` : '📷 上传护照 OCR'}
            <input
              type="file"
              accept="image/*,.pdf"
              className="hidden"
              disabled={ocring}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleOcr(f);
              }}
            />
          </label>
          {onRemove && (
            <button type="button" className="text-xs font-medium text-ink-muted transition hover:text-deal" onClick={onRemove}>
              删除
            </button>
          )}
        </div>
      </div>
      {ocring && ocrStage && (
        <div className="mt-2.5 rounded-xl border border-brand-200 bg-brand-50/60 px-3 py-2 text-xs text-brand-800">
          <div className="mb-1 flex items-center justify-between">
            <span>{ocrStage.label}</span>
            <span className="font-semibold nums">{ocrStage.pct.toFixed(0)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-brand-100">
            <div className="h-full bg-brand transition-all" style={{ width: `${ocrStage.pct}%` }} />
          </div>
        </div>
      )}
      {ocrResult && (
        <div className={`mt-2.5 rounded-xl px-3 py-2 text-xs ${ocrResult.ok ? 'border border-brand-200 bg-brand-50/60 text-brand-800' : 'border border-sun/40 bg-sun-light text-amber-800'}`}>
          <div className="font-medium">{ocrResult.msg}</div>
          {ocrResult.preview && (
            <details className="mt-1 text-[10px] opacity-70">
              <summary className="cursor-pointer">查看识别原文</summary>
              <pre className="mt-1 whitespace-pre-wrap font-mono">{ocrResult.preview}</pre>
            </details>
          )}
        </div>
      )}
      {imagePreview && (
        <div className="mt-2.5">
          <img src={imagePreview} alt="护照预览" className="max-h-24 rounded-xl border border-slate-200" />
        </div>
      )}
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <div>
          <label className="label text-xs">姓名 *（与护照一致）</label>
          <input
            className="input"
            required
            value={passenger.fullName}
            onChange={(e) => onChange({ fullName: e.target.value })}
            placeholder="如 CHAN MAN HO 陈文豪"
          />
        </div>
        <div>
          <label className="label text-xs">护照号 *</label>
          <input
            className="input"
            required
            value={passenger.passportNumber}
            onChange={(e) => onChange({ passportNumber: e.target.value })}
            placeholder="如 MA1234567"
          />
        </div>
        <div>
          <label className="label text-xs">联系电话 *</label>
          <input
            className="input"
            required
            value={passenger.phone}
            onChange={(e) => onChange({ phone: e.target.value })}
            placeholder="紧急联系电话"
          />
        </div>
        <div>
          <label className="label text-xs">出生日期</label>
          <input
            type="date"
            className="input"
            value={passenger.dateOfBirth}
            onChange={(e) => onChange({ dateOfBirth: e.target.value })}
          />
        </div>
        <div>
          <label className="label text-xs">国籍 / 地区</label>
          <select
            className="input"
            value={passenger.nationality}
            onChange={(e) => onChange({ nationality: e.target.value })}
          >
            <option value="MO">中国澳门 MO</option>
            <option value="HK">中国香港 HK</option>
            <option value="CN">中国 CN</option>
            <option value="TW">中国台湾 TW</option>
          </select>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// HoldCountdown — 展示座位保留倒计时 (mm:ss)。超时提示：订单作废，需重新下单。
// ─────────────────────────────────────────────────────────────────
function HoldCountdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const endMs = new Date(expiresAt).getTime();
  const leftMs = Math.max(0, endMs - now);
  const mm = Math.floor(leftMs / 60000);
  const ss = Math.floor((leftMs % 60000) / 1000);
  const expired = leftMs === 0;

  return (
    <div className={`mt-4 rounded-xl px-3 py-2.5 text-sm ${
      expired ? 'border border-deal/30 bg-deal-light text-deal-dark'
        : leftMs < 5 * 60 * 1000 ? 'border border-sun/40 bg-sun-light text-amber-800'
        : 'border border-slate-200/80 bg-canvas text-ink-soft'
    }`}>
      {expired ? (
        <>⚠ 支付超时，座位已自动释放。请返回购物车重新下单。</>
      ) : (
        <>⏱️ 座位保留中 · 剩余 <strong className="font-mono tabular-nums">{String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}</strong> 完成支付，否则座位释放回库存</>
      )}
    </div>
  );
}

