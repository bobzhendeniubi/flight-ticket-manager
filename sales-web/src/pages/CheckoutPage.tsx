/**
 * 结账页 — 输入乘客信息（姓名、护照号、电话），可上传护照走 tesseract.js OCR 自动填表。
 *
 * 下单流程：POST /orders → 服务端重算价格 + 扣座位 + 生成订单号 → 跳完成页。
 */
import { FormEvent, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCart, KIND_INFO } from '../stores/cart';
import { useAuth } from '../stores/auth';
import { ocrPassport } from '../lib/passportOcr';
import { api, ApiError, type CreateOrderInput } from '../lib/api';

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

// Real OCR 走 Tesseract.js（chi_sim + eng 语言包 + MRZ 解析）
// 见 lib/passportOcr.ts

export function CheckoutPage() {
  const user = useAuth((s) => s.user);
  const tokens = useAuth((s) => s.tokens);
  const isAgent = user?.role === 'AGENT';
  const items = useCart((s) => s.items);
  const total = useCart((s) => s.items.reduce((sum, i) => sum + i.unitPrice * i.qty, 0));
  const clear = useCart((s) => s.clear);

  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [passengers, setPassengers] = useState<PassengerForm[]>([{ ...EMPTY_PASSENGER }]);
  const [paymentMethod, setPaymentMethod] = useState<CreateOrderInput['paymentMethod']>('WECHAT_PAY');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [done, setDone] = useState<{ orderNumber: string; total: string } | null>(null);

  // 需要出行人的总人数 = 机票张数（取 meta.passengers，因 FLIGHT 购物车 qty=1 是技巧）
  const flightTicketCount = useMemo(
    () =>
      items
        .filter((i) => i.kind === 'FLIGHT')
        .reduce((sum, i) => sum + (Number(i.meta?.passengers) || i.qty), 0),
    [items],
  );
  const bundlePaxCount = items
    .filter((i) => i.kind === 'BUNDLE')
    .reduce((sum, i) => sum + (Number(i.meta?.pax) || 0), 0);
  // 如果同时买了散票和套餐，取较大值（套餐含机票，乘客是同一批人）
  const effectivePax = bundlePaxCount > 0 ? bundlePaxCount : flightTicketCount;
  const paxMismatch = effectivePax > 0 && passengers.length !== effectivePax;
  const hasBundle = items.some((i) => i.kind === 'BUNDLE');

  if (items.length === 0 && !done) {
    return (
      <div className="card text-center py-16">
        <p className="text-slate-600">购物车是空的</p>
        <Link to="/" className="btn-primary mt-4 inline-block">
          先去挑产品
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="card max-w-lg mx-auto text-center py-12">
        <div className="text-5xl">🎉</div>
        <h1 className="mt-3 text-2xl font-bold text-slate-900">下单成功</h1>
        <p className="mt-2 text-sm text-slate-600">订单号</p>
        <p className="font-mono text-lg text-slate-900">{done.orderNumber}</p>
        <p className="mt-2 text-sm text-slate-700">
          应付 <span className="text-lg font-bold text-red-600">¥{Number(done.total).toLocaleString()}</span>
        </p>
        <p className="mt-3 text-sm text-slate-500">
          订单已创建，状态为 <span className="font-medium">待支付</span>。
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
        `需要 ${effectivePax} 位出行人（${flightTicketCount > 0 ? `机票 ${flightTicketCount} 张` : ''}${bundlePaxCount > 0 ? ` 套餐 ${bundlePaxCount} 人` : ''}），当前填了 ${passengers.length} 位`,
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
    if (hasBundle) {
      setErrorMsg('套餐产品暂未接入后端（等 M6 产品模块上线）。请先把套餐从购物车移除，或单独购买组件。');
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
        return []; // BUNDLE 已上面拒绝，不会到这里
      }),
      idempotencyKey:
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };

    setSubmitting(true);
    try {
      const { order } = await api.createOrder(tokens.accessToken, body);
      clear();
      setDone({ orderNumber: order.orderNumber, total: order.total });
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorMsg(`下单失败：${err.message}`);
      } else {
        setErrorMsg('下单失败，请稍后重试');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      <section>
        <h1 className="text-2xl font-bold text-slate-900">确认订单</h1>
        <p className="mt-1 text-sm text-slate-600">
          请填写联系人信息和每位乘客的护照信息。可上传护照照片自动识别（OCR）。
        </p>
        {errorMsg && (
          <div className="mt-3 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
            ❌ {errorMsg}
          </div>
        )}
      </section>

      <form onSubmit={onSubmit} className="space-y-5">
        {/* 订单内容摘要 */}
        <section className="card">
          <h2 className="font-semibold text-slate-900">订单内容</h2>
          <ul className="mt-3 space-y-2">
            {items.map((i) => (
              <li key={i.id} className="flex items-center gap-3 text-sm">
                <span className="text-2xl">{i.emoji}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-xs font-medium ${KIND_INFO[i.kind].color}`}
                >
                  {KIND_INFO[i.kind].label}
                </span>
                <span className="flex-1 text-slate-900 truncate">{i.name}</span>
                <span className="text-slate-500">× {i.qty}</span>
                <span className="w-20 text-right font-medium">¥{(i.unitPrice * i.qty).toLocaleString()}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center justify-between border-t border-slate-200 pt-3">
            <span className="text-sm text-slate-600">合计</span>
            <span className="text-2xl font-bold text-red-600">¥{total.toLocaleString()}</span>
          </div>
        </section>

        {/* 联系人 */}
        <section className="card">
          <h2 className="font-semibold text-slate-900">联系人信息</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
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
          </div>
        </section>

        {/* 乘客 / 出行人 */}
        <section className="card">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-900">
              出行人信息（{passengers.length} 人
              {effectivePax > 0 && ` / 需要 ${effectivePax} 人`}）
            </h2>
            <button type="button" className="text-sm text-brand hover:text-brand-dark" onClick={addPassenger}>
              + 增加出行人
            </button>
          </div>
          <p className="mt-1 text-xs text-slate-500">机票、签证按出行人开票/办证。每位都需提供护照信息。</p>
          {paxMismatch && (
            <div className="mt-2 rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
              ⚠ 需要 {effectivePax} 位出行人，当前填了 {passengers.length} 位。
              请{passengers.length < effectivePax ? '增加出行人' : '减少出行人或返回购物车调整数量'}。
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
          <h2 className="font-semibold text-slate-900">支付方式</h2>
          <div className="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-4">
            {[
              { v: 'WECHAT_PAY', label: '微信支付', emoji: '💚', show: true },
              { v: 'ALIPAY', label: '支付宝', emoji: '💙', show: true },
              { v: 'BANK_CARD', label: '信用卡', emoji: '💳', show: true },
              { v: 'AGENT_PREPAYMENT', label: '代理预付余额', emoji: '💰', show: isAgent },
            ].filter((p) => p.show).map((p) => (
              <label
                key={p.v}
                className={`cursor-pointer rounded-md border-2 p-3 text-center ${
                  paymentMethod === p.v ? 'border-brand bg-brand/5' : 'border-slate-200 hover:border-slate-300'
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
                <div className="mt-1 text-sm font-medium text-slate-900">{p.label}</div>
              </label>
            ))}
          </div>
          {paymentMethod === 'AGENT_PREPAYMENT' && isAgent && (
            <div className="mt-3 rounded-md bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-emerald-800">代理预付余额（demo 模拟）</span>
                <span className="font-semibold text-emerald-700">¥80,000.00</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-xs text-emerald-600">
                <span>本单抵扣</span>
                <span>−¥{total.toLocaleString()}</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-xs text-emerald-600">
                <span>支付后余额</span>
                <span>¥{(80000 - total).toLocaleString()}</span>
              </div>
              {total > 80000 && (
                <div className="mt-2 text-xs text-red-600">⚠ 余额不足，请联系管理员充值或选择其他支付方式</div>
              )}
            </div>
          )}
        </section>

        <div className="flex items-center justify-between sticky bottom-0 bg-white border border-slate-200 rounded-md px-4 py-3 shadow-lg">
          <Link to="/cart" className="text-sm text-slate-500 hover:text-brand">
            ← 返回购物车
          </Link>
          <div className="flex items-center gap-4">
            <span>
              合计 <span className="text-2xl font-bold text-red-600">¥{total.toLocaleString()}</span>
            </span>
            <button type="submit" className="btn-primary" disabled={submitting || paxMismatch}>
              {submitting ? '提交中…' : '提交订单'}
            </button>
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
    <div className="rounded-md border border-slate-200 bg-slate-50/50 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">出行人 #{idx + 1}</h3>
        <div className="flex items-center gap-3">
          <label className="cursor-pointer text-xs text-brand hover:text-brand-dark">
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
            <button type="button" className="text-xs text-slate-400 hover:text-red-600" onClick={onRemove}>
              删除
            </button>
          )}
        </div>
      </div>
      {ocring && ocrStage && (
        <div className="mt-2 rounded bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-800">
          <div className="flex items-center justify-between mb-1">
            <span>{ocrStage.label}</span>
            <span className="font-semibold">{ocrStage.pct.toFixed(0)}%</span>
          </div>
          <div className="h-1.5 bg-blue-100 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 transition-all" style={{ width: `${ocrStage.pct}%` }} />
          </div>
        </div>
      )}
      {ocrResult && (
        <div className={`mt-2 rounded px-3 py-2 text-xs ${ocrResult.ok ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-800 border border-amber-200'}`}>
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
        <div className="mt-2">
          <img src={imagePreview} alt="护照预览" className="max-h-24 rounded border border-slate-200" />
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
