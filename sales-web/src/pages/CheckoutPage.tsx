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
import { passportFileToDataUrl } from '../lib/passportImage';
import { api, ApiError, type CreateOrderInput } from '../lib/api';
import { safeRandomUUID } from '../lib/uuid';
import { BookingNotices } from '../components/BookingNotices';
import { TrustBadges } from '../components/TrustBadges';
import { RefundBadge } from '../components/RefundBadge';
import { PaymentPanel } from '../components/PaymentPanel';
import { Icon } from '../components/Icon';

/** 手机号轻校验：允许 +、空格、-，纯数字位数 7–15（含国际区号）。空串不在这里判（必填由调用方控制）。 */
function isLikelyPhone(raw: string): boolean {
  const digits = raw.replace(/[^\d]/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

/** 证件有效期格式：YYYY-MM-DD（与后端同款正则；date input 正常输出即为此格式） */
const DATE_INPUT_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 证件有效期提醒：不足 6 个月 / 已过期时给一句黄字提示。
 * 只提醒、不拦截 —— 各目的地入境要求不同，交由客服跟进，不替客人做决定。
 */
function expiryNotice(expiry?: string): string | null {
  if (!expiry || !DATE_INPUT_RE.test(expiry)) return null;
  const end = new Date(`${expiry}T00:00:00`);
  if (Number.isNaN(end.getTime())) return null;
  const days = Math.floor((end.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return '该证件已过期，请更换为在有效期内的证件';
  if (days < 180) return '有效期不足 6 个月，多数目的地要求 6 个月以上，建议先换发新证件';
  return null;
}

interface PassengerForm {
  fullName: string;
  passportNumber: string;
  phone: string;
  dateOfBirth: string;
  nationality: string;
  /**
   * 护照全采集字段（客源地分析）——「只在 OCR 时采，不让手填」：
   * 仅当上传护照 OCR 命中 MRZ 时自动写入，UI 只读展示，不作必填、不阻断提交。
   * 空 = 该出行人没走 OCR 或未命中 MRZ；提交时省略，绝不发 ''。
   */
  gender?: 'M' | 'F' | 'X';
  /**
   * 证件有效期 YYYY-MM-DD —— 含机票/套餐/签证的订单**每位出行人必填**（后端
   * createOrderBodySchema 同款拦截）；纯酒店/接送单选填。
   * OCR 命中 MRZ 时自动带出，客人也可手填/改；提交前由 onSubmit 校验。
   */
  passportExpiry?: string; // YYYY-MM-DD
  passportIssueCountry?: string; // ISO-2
  /**
   * 护照签发地点（自由文本，如「广东省广州市」）——与 ISO-2 签发国 passportIssueCountry 区分开。
   * OCR 命中时自动填；手填选填，永不阻断提交。空 = 未采集，提交时省略，绝不发 ''。
   */
  passportIssuePlace?: string;
  /**
   * 护照图片 data-URL——上传/OCR 时顺带捕获，随下单一起传给后端落库。
   * 超过 6MB 时前端先压缩（canvas 等比缩放 + JPEG 降质）再存，避免后端 413。
   */
  passportPhotoUrl?: string;
  /**
   * 中文姓名（镜像后端 passengerInputSchema.chineseName）。
   * tesseract.js 本地 OCR 基本识别不出中文名，留空即可；有值才传，不发空串。
   */
  chineseName?: string;
  /**
   * 护照签发日期 YYYY-MM-DD（镜像后端 passengerInputSchema.passportIssueDate）。
   * OCR 命中时由 ocrPassport 带出；手填不强制。有值才传，空串省略。
   */
  passportIssueDate?: string;
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

// 护照图压缩（passportFileToDataUrl）已抽到 lib/passportImage.ts，
// 与订单页护照补录弹窗（PassengerPassportModal）共用。

// Real OCR 走 Tesseract.js（chi_sim + eng 语言包 + MRZ 解析）
// 见 lib/passportOcr.ts

export function CheckoutPage() {
  const user = useAuth((s) => s.user);
  const tokens = useAuth((s) => s.tokens);
  const isAgent = user?.role === 'AGENT';
  // 登录态：有有效 accessToken 即视为已登录；否则走游客分支（A1：去登录墙）
  const isLoggedIn = Boolean(tokens?.accessToken);
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
  // A1 游客下单：未登录时让用户二选一 —— 去登录 OR 以游客身份继续。
  // null = 还没选；'guest' = 已选游客（露出联系人必填字段）。已登录时此状态不参与。
  const [guestChoice, setGuestChoice] = useState<'guest' | null>(null);
  // A5 优惠码：后端暂无促销端点，输入框可见但不参与算价（不伪造折扣）。
  const [promoCode, setPromoCode] = useState('');
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
          gender?: 'M' | 'F' | 'X';
          passportExpiry?: string;
          passportIssueCountry?: string;
          passportIssuePlace?: string;
        }>;
        if (ocrList.length > 0) {
          return ocrList.map((p) => ({
            fullName: p.fullName ?? '',
            passportNumber: p.passportNumber ?? '',
            phone: '',
            dateOfBirth: p.dateOfBirth ?? '',
            nationality: p.nationality ?? 'CN',
            // AI 助手 OCR 命中 MRZ 时带过来的护照全采集字段（缺失则 undefined，只读展示，不发送空值）
            gender: p.gender,
            passportExpiry: p.passportExpiry,
            passportIssueCountry: p.passportIssueCountry,
            passportIssuePlace: p.passportIssuePlace,
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
    isGuest: boolean;
    contactPhone: string;
  } | null>(null);
  // H3：捕获到 401/会话过期时置真 —— 渲染"重新登录"专用提示而非通用失败文案。
  const [sessionExpired, setSessionExpired] = useState(false);

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
  // 套餐出行人数 = 占座模型 headCount（成人 + 占座儿童 + 不占座婴儿，都需护照）。
  // 优先读三计数之和；缺失（老购物车）回退旧 pax（= headCount）。婴儿不占座但仍要护照 → 计入。
  const bundlePaxCount = items
    .filter((i) => i.kind === 'BUNDLE')
    .reduce((sum, i) => {
      const adult = Number(i.meta?.adultCount);
      const child = Number(i.meta?.childCount);
      const infant = Number(i.meta?.infantCount);
      const hasCounts =
        Number.isFinite(adult) || Number.isFinite(child) || Number.isFinite(infant);
      const headCount = hasCounts
        ? (Number.isFinite(adult) ? adult : 0) +
          (Number.isFinite(child) ? child : 0) +
          (Number.isFinite(infant) ? infant : 0)
        : Number(i.meta?.pax) || 0;
      return sum + headCount;
    }, 0);
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
  // 证件有效期必填范围：含机票/套餐/签证（要凭证件出境的产品）时每位出行人必填，
  // 与后端 createOrderBodySchema 同口径。纯酒店/接送单只作选填，不给客人添堵。
  const expiryRequired = items.some(
    (i) => i.kind === 'FLIGHT' || i.kind === 'BUNDLE' || i.kind === 'VISA',
  );
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
      <div className="mx-auto max-w-lg space-y-4 pb-12">
        <div className="card animate-fade-up py-10 text-center">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-brand-50 text-5xl">🎉</div>
          <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-ink">下单成功</h1>
          <p className="mt-3 text-sm text-ink-muted">订单号</p>
          <p className="mt-1 inline-block rounded-xl bg-canvas px-4 py-1.5 font-mono text-lg font-semibold text-ink nums">
            {done.orderNumber}
          </p>
          {done.paymentExpiresAt ? (
            <HoldCountdown expiresAt={done.paymentExpiresAt} />
          ) : (
            <div className="mt-4 rounded-xl border border-slate-200/80 bg-canvas px-3 py-2.5 text-sm text-ink-soft">
              🎫 座位已锁定，线下结算 · 不限时
            </div>
          )}
          <p className="mt-4 text-sm text-ink-muted">
            订单已创建，状态为 <span className="badge-sun">待确认</span>。
            请按下方收款方式付款并上传凭证，已发短信至 {done.contactPhone}
          </p>
        </div>

        {/* 收款方式 + 上传付款凭证：买家可立即付款，也可稍后凭订单号回来付 */}
        <PaymentPanel
          orderNo={done.orderNumber}
          lookupKey={done.contactPhone}
          amountDueCny={Number(done.total) || 0}
          variant="success"
        />

        {done.isGuest && (
          <div className="card animate-fade-up rounded-2xl border border-brand-200 bg-brand-50/60 text-left text-sm text-brand-800">
            <p className="flex items-center gap-1.5 font-semibold">
              <Icon name="search" className="h-4 w-4" /> 凭「订单号 + 手机号」可随时查订单
            </p>
            <p className="mt-1 text-brand-700">
              未登录下单不会进入「我的订单」。请记下订单号
              <span className="mx-1 font-mono font-semibold">{done.orderNumber}</span>，
              到{' '}
              <Link to="/lookup" className="font-semibold underline underline-offset-2 hover:text-brand-dark">
                查订单
              </Link>{' '}
              页面输入订单号与下单手机号即可继续付款、查看进度。
            </p>
          </div>
        )}

        <div className="flex justify-center gap-3">
          <Link to="/" className="btn-secondary">
            返回首页
          </Link>
          {done.isGuest ? (
            <Link to="/lookup" className="btn-primary">
              去查订单
            </Link>
          ) : (
            <Link to="/orders" className="btn-primary">
              查看我的订单
            </Link>
          )}
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
    setSessionExpired(false);

    // A1：未登录且还没选"游客继续"时，先逼用户做选择（登录 or 游客），不直接提交
    if (!isLoggedIn && guestChoice !== 'guest') {
      setErrorMsg('请先选择「登录后下单」或「以游客身份继续」');
      return;
    }

    // Invariant: 买几张票/套餐几人就填几个出行人
    if (effectivePax > 0 && passengers.length !== effectivePax) {
      setErrorMsg(
        `本次行程共需 ${effectivePax} 位出行人的护照信息，您已填写 ${passengers.length} 位，还差 ${Math.abs(effectivePax - passengers.length)} 位，请${passengers.length < effectivePax ? '补全' : '删除多余的出行人'}后再提交。`,
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
    // 证件有效期：含机票/套餐/签证时每位必填（同后端口径），文案指到第几位出行人
    if (expiryRequired) {
      const missingExpiryIdx = passengers.findIndex((p) => !p.passportExpiry?.trim());
      if (missingExpiryIdx >= 0) {
        setErrorMsg(`请填写第 ${missingExpiryIdx + 1} 位出行人的证件有效期`);
        return;
      }
    }
    // 填了就要合法（纯酒店/接送单选填，填错一样拦，避免脏数据进签证台）
    const badExpiryIdx = passengers.findIndex(
      (p) => p.passportExpiry?.trim() && !DATE_INPUT_RE.test(p.passportExpiry.trim()),
    );
    if (badExpiryIdx >= 0) {
      setErrorMsg(`第 ${badExpiryIdx + 1} 位出行人的证件有效期格式不正确，请按年-月-日选择`);
      return;
    }
    // 出行人联系电话：必填 + 轻校验（位数 7–15）
    if (passengers.some((p) => !p.phone.trim())) {
      setErrorMsg('请填写每位出行人的联系电话');
      return;
    }
    if (passengers.some((p) => !isLikelyPhone(p.phone))) {
      setErrorMsg('出行人联系电话格式不正确，请填写 7–15 位有效号码');
      return;
    }
    if (!contactName.trim() || !contactPhone.trim()) {
      setErrorMsg('请填写联系人姓名和手机号');
      return;
    }
    if (!isLikelyPhone(contactPhone)) {
      setErrorMsg('联系人手机号格式不正确，请填写 7–15 位有效号码');
      return;
    }

    // 已登录 → 用 accessToken，后端按用户关联；游客 → token=null + guestContact
    const submitAsGuest = !isLoggedIn;
    const token = submitAsGuest ? null : tokens!.accessToken;

    // 购物车 → CreateOrderInput.items
    const body: CreateOrderInput = {
      contactName: contactName.trim(),
      contactPhone: contactPhone.trim(),
      contactEmail: contactEmail.trim() || undefined,
      // 游客下单：联系人同时作为 guestContact 传给后端（已登录省略，后端用 token 关联用户）
      ...(submitAsGuest
        ? {
            guestContact: {
              name: contactName.trim(),
              phone: contactPhone.trim(),
              email: contactEmail.trim() || undefined,
            },
          }
        : {}),
      notes: orderNotes.trim() || undefined,
      paymentMethod,
      passengers: passengers.map((p) => ({
        fullName: p.fullName.trim(),
        documentType: 'PASSPORT',
        documentNumber: p.passportNumber.trim(),
        dateOfBirth: p.dateOfBirth,
        nationality: p.nationality || 'CN',
        passengerType: 'ADULT',
        // 证件有效期：含机票/套餐/签证时必填（提交前已校验，见 onSubmit）；
        // 纯酒店/接送单选填 —— 空值省略，绝不发 ''（后端 YYYY-MM-DD 正则会拒空串）。
        ...(p.passportExpiry?.trim() ? { passportExpiry: p.passportExpiry.trim() } : {}),
        // 其余护照全采集字段（仅 OCR 命中 MRZ 时有值）。空/undefined 一律省略 ——
        // passportIssueCountry 后端是严格长度校验，发 '' 会被拒。
        ...(p.gender ? { gender: p.gender } : {}),
        ...(p.passportIssueCountry ? { passportIssueCountry: p.passportIssueCountry } : {}),
        // 护照签发地点（自由文本）：有值才传，空/undefined 省略
        ...(p.passportIssuePlace?.trim() ? { passportIssuePlace: p.passportIssuePlace.trim() } : {}),
        // 护照图落库：有图才传，空串同样省略（压缩兜底返回 '' 时）
        ...(p.passportPhotoUrl ? { passportPhotoUrl: p.passportPhotoUrl } : {}),
        // 中文姓名 / 护照签发日期：有值才传，不发空串（后端正则校验 passportIssueDate）
        ...(p.chineseName ? { chineseName: p.chineseName } : {}),
        ...(p.passportIssueDate ? { passportIssueDate: p.passportIssueDate } : {}),
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
          // H12：散客单买酒店必 400 的根因——这里以前只发 description/quantity/unitPrice，
          // 丢了 hotelRoomTypeId。后端对游客/CUSTOMER（allowClientPricedGround=false）无 id 的
          // 地面行一律拒单（"必须选择系统内的…产品，不能自定义价格"）。
          // hotelRoomTypeId 在加购时已存进 meta（见 HotelDetailPage.tsx handleAdd）。
          //
          // 购物车里 i.unitPrice = 总价（每晚价 × 晚数 × 房数，qty 固定 1，见 HotelDetailPage.tsx
          // 的 total = perNight * nights * rooms）。后端权威重算口径是
          // 「hotelRoomTypeId 查到的每晚价 × quantity(晚数) × roomsBilled(房数)」，且带 id 时会用
          // assertAmountWithinTolerance 比对 unitPrice×quantity —— quantity 必须传晚数、
          // unitPrice 必须还原成每晚价，否则会被误判成价格漂移（PRICE_CHANGED）而拒单。
          const nights = Math.max(1, Math.round(Number(i.meta?.nights)) || 1);
          const rooms = Math.max(1, Math.round(Number(i.meta?.rooms)) || 1);
          // HotelsPage.tsx 列表页"卡片内直接加购"在酒店没有房型时会写入空串兜底 —— 空串会被
          // 后端 z.string().min(1) 拒成生硬的校验错误，这里当无 id 处理（退化到旧的拒单文案）。
          const hotelRoomTypeId =
            typeof i.meta?.hotelRoomTypeId === 'string' && i.meta.hotelRoomTypeId.length > 0
              ? i.meta.hotelRoomTypeId
              : undefined;
          const perNightPrice = Math.round(i.unitPrice / (nights * rooms)) || 0;
          return [{
            kind: 'HOTEL',
            description: i.name,
            quantity: nights,
            unitPrice: perNightPrice,
            hotelRoomTypeId,
            checkIn: i.meta?.checkIn ? String(i.meta.checkIn) : undefined,
            checkOut: i.meta?.checkOut ? String(i.meta.checkOut) : undefined,
            roomsBilled: rooms,
          }];
        }
        if (i.kind === 'TRANSFER') {
          // H12：同上——接送产品 id（transfer.id）加购时就是 i.productId（见 TransferDetailPage.tsx /
          // TransfersPage.tsx 的 add()），这里以前没透传，导致游客单买接送必 400。
          return [{
            kind: 'TRANSFER',
            description: i.name,
            quantity: i.qty,
            unitPrice: i.unitPrice,
            transferId: i.productId,
          }];
        }
        if (i.kind === 'VISA') {
          // H12：签证同理。但签证的 productId 在加购时被拼成了 `visa.id + '-express'`
          // （VisaDetailPage.tsx 加急项要与普通项区分购物车行），不能直接当 visaId 用。
          // 真实 visaId 已在加购时顺手存进 meta.visaId；老购物车数据（升级前已加购、只有拼串
          // 没有 meta.visaId）才退化为剥 '-express' 后缀兜底。
          const visaId =
            typeof i.meta?.visaId === 'string'
              ? i.meta.visaId
              : i.productId.endsWith('-express')
                ? i.productId.slice(0, -'-express'.length)
                : i.productId;
          return [{
            kind: 'VISA',
            description: i.name,
            quantity: i.qty,
            unitPrice: i.unitPrice,
            visaId,
            // 加急附加费：后端 unitPrice = basePrice + (metadata.express ? expressSurcharge : 0)，
            // 前端购物车 unitPrice 在加购时就是这个口径（VisaDetailPage.tsx），两边一致，
            // 只要把 express 标记带过去即可，不会触发容差拒单。
            ...(i.meta?.express ? { metadata: { express: true } } : {}),
          }];
        }
        if (i.kind === 'BUNDLE') {
          // 把行程要素透传给后端 —— 后端据此写入套餐订单的酒店占房明细（房控板计入）
          const bundleMeta: Record<string, unknown> = {};
          if (i.meta?.goDate !== undefined) bundleMeta.goDate = i.meta.goDate;
          if (i.meta?.returnDate !== undefined) bundleMeta.returnDate = i.meta.returnDate;
          if (i.meta?.pax !== undefined) bundleMeta.pax = i.meta.pax;
          if (i.meta?.rooms !== undefined) bundleMeta.rooms = i.meta.rooms;

          // ── 占座模型三计数（缺失 = 老购物车 → 回退旧 pax 当全成人，与旧行为一致）──
          //   seatPax  = 成人 + 占座儿童（占座、扣经济舱座位、拼房）
          //   headCount= 成人 + 占座儿童 + 不占座婴儿（出行人，都要护照）
          const adultExplicit = i.meta?.adultCount;
          const childExplicit = i.meta?.childCount;
          const infantExplicit = i.meta?.infantCount;
          const hasCounts =
            adultExplicit !== undefined ||
            childExplicit !== undefined ||
            infantExplicit !== undefined;
          const adultCount = hasCounts
            ? Math.max(0, Number(adultExplicit) || 0)
            : Math.max(1, Number(i.meta?.pax) || 1);
          const childCount = hasCounts ? Math.max(0, Number(childExplicit) || 0) : 0;
          const infantCount = hasCounts ? Math.max(0, Number(infantExplicit) || 0) : 0;
          const seatPax = Math.max(1, adultCount + childCount); // 占座（≥1）

          // 可选升级 add-on 份数（缺省 0 = 无升级）
          const singleCount = Math.max(0, Number(i.meta?.singleCount) || 0);
          const businessCount = Math.max(0, Number(i.meta?.businessCount) || 0);
          const goLegScheduleId =
            typeof i.meta?.goLegScheduleId === 'string' ? i.meta.goLegScheduleId : '';
          const retLegScheduleId =
            typeof i.meta?.retLegScheduleId === 'string' ? i.meta.retLegScheduleId : '';

          // BUNDLE 行 = 纯地面口径（机票拆成独立 FLIGHT 行单独动态计价）。
          // 后端 bundleUnitPrice 本就只含地面（items[kind!==FLIGHT] − groundDiscount）；
          // 占座儿童折扣 / 婴儿价 / 单人入住 / 升舱的加价由后端 computeBundleAddOn 一次性加到本 BUNDLE 行
          // （与航段条数无关）。所以无论拆几条 FLIGHT 行，加价都不会被重复收。
          // 三计数（adult/child/infant）传给后端 → 后端权威重算占座/出行人/拼房/儿童折扣/婴儿价。
          const bundleLine = {
            kind: 'BUNDLE' as const,
            description: i.name,
            quantity: i.qty,
            unitPrice: i.unitPrice,
            bundleId: i.productId,
            adultCount,
            childCount,
            infantCount,
            singleCount,
            businessCount,
            ...(Object.keys(bundleMeta).length > 0 ? { metadata: bundleMeta } : {}),
          };

          // 套餐订单把往返机票计入并扣座位：每个套餐项总是拆出去程 + 回程两条经济舱 FLIGHT 行
          // （quantity = seatPax = 占座人数，婴儿不占座、不发机票座位），后端按各航段真实经济舱动态价收费 +
          // 各扣 seatPax 个座位；businessCount>0 时再把 businessCount 个座位从两段经济舱拆到真实商务舱库存（超售则拒）。
          //
          // 出行人数：后端 computeRequiredPassengerCount 对 FLIGHT 行取「单段最大人数」MAX（往返同一批人），
          // 但对 BUNDLE 行按 headCount（含婴儿）→ required = max(seatPax, headCount) = headCount，
          // 婴儿也要一行护照（不是 seatPax）。
          //
          // 客户总价 = 去程经济舱×seatPax + 回程经济舱×seatPax + 地面 + 儿童折扣/婴儿价/单人入住/升舱加价 − 立减，
          // 与卡片展示价一致，也与后端权威重算逐行相加一致（>1 元偏差会被后端拒）。
          const legScheduleIds = [goLegScheduleId, retLegScheduleId].filter(
            (id): id is string => Boolean(id),
          );
          const legLabel: Record<number, string> = { 0: '去程（经济舱）', 1: '回程（经济舱）' };
          const flightLines = legScheduleIds.map((scheduleId, legIdx) => ({
            kind: 'FLIGHT' as const,
            description: `${i.name} · ${legLabel[legIdx] ?? '航段（经济舱）'}`,
            quantity: seatPax,
            flightScheduleId: scheduleId,
            flightCabin: 'ECONOMY' as const,
            // 给机票腿打 bundleId 标 → 后端据此按该套餐 discountPct 对这两条机票腿打折。
            bundleId: i.productId,
          }));

          // 退路：套餐缺航段 id（异常 / 老购物车数据 / 单程）→ 只发可用航段（可能为 0 条）+ BUNDLE 行，
          // 绝不崩。若一条 FLIGHT 行都没有且 businessCount>0，后端会因无经济舱航段友好拒绝升舱。
          return [...flightLines, bundleLine];
        }
        return [];
      }),
      idempotencyKey,
      // 前台展示总价兜底（S1）：带上结算页看到的合计，后端权威商品价与之偏差 > 1 元 → 回 PRICE_CHANGED，
      // 防止「展示价与实收价背离」时静默多收（如套餐机票展示 ¥0、下单拆腿按真实机票价实扣）。
      expectedTotalCny: Math.round(total),
    };

    const orderedIds = items.map((i) => i.id);
    setSubmitting(true);
    try {
      const { order } = await api.createOrder(token, body);
      removeMany(orderedIds); // 只移除本次结算的产品，未勾选的留在购物车
      clearPassengers(); // 防止下单成功后下次开新单沿用旧 OCR 缓存（Codex P2 反馈）
      setDone({
        orderNumber: order.orderNumber,
        total: order.total,
        paymentExpiresAt: order.paymentExpiresAt ?? null,
        isGuest: submitAsGuest,
        contactPhone: contactPhone.trim(),
      });
    } catch (err) {
      // H3：会话过期/未授权 → 友好"重新登录"提示，不混在通用失败里
      if (err instanceof ApiError && err.status === 401) {
        setSessionExpired(true);
        setErrorMsg(null);
      } else if (err instanceof ApiError && err.code === 'PRICE_CHANGED') {
        // 价格漂移兜底（S1）：展示价与后端权威价不一致 → 明确提示刷新重下，绝不让用户按旧价被多收。
        setErrorMsg('价格已更新，请刷新页面后重新下单（航班或产品价格发生了变化）。');
      } else if (err instanceof ApiError) {
        setErrorMsg(`下单失败：${err.message}`);
      } else {
        // 任何异常都要给用户可见反馈（公测反馈：失败时页面"卡住"无提示）
        setErrorMsg(err instanceof Error ? err.message : '提交失败，请重试');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5 pb-44 sm:pb-32">
      <section className="animate-fade-up">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">确认订单</h1>
        <p className="section-sub">
          请填写联系人信息和每位乘客的护照信息。可上传护照照片自动识别（OCR）。
        </p>

        {/* A5 步骤指示器（纯展示，不改流程） */}
        <CheckoutSteps />

        {/* H3 会话过期专用提示（带重新登录入口） */}
        {sessionExpired && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-sun/40 bg-sun-light px-4 py-3 text-sm font-medium text-amber-800">
            <span className="inline-flex items-center gap-1.5">
              <Icon name="info" className="h-4 w-4" /> 登录已过期，请重新登录后再下单
            </span>
            <Link to="/login?redirect=/checkout" className="btn-primary ml-auto px-4 py-1.5 text-sm">
              重新登录
            </Link>
          </div>
        )}

        {errorMsg && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-deal/30 bg-deal-light px-4 py-3 text-sm font-medium text-deal-dark">
            <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0" /> <span>{errorMsg}</span>
          </div>
        )}
      </section>

      <form onSubmit={onSubmit} className="space-y-5">
        {/* A1 未登录：给清晰二选一（登录 OR 游客继续），不再硬性拦截 */}
        {!isLoggedIn && (
          <section className="card border-brand-200 bg-brand-50/40">
            <h2 className="section-title text-base">下单方式</h2>
            <p className="mt-1 text-sm text-ink-soft">
              你还没有登录。可以登录后下单（订单进「我的订单」便于管理），也可以直接以游客身份下单。
            </p>
            <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
              <Link
                to="/login?redirect=/checkout"
                className="flex items-center gap-3 rounded-2xl border-2 border-slate-200 bg-surface p-3.5 text-left transition-all hover:border-brand/50 hover:bg-brand-50/50"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand">
                  <Icon name="user" className="h-5 w-5" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-ink">登录后下单</span>
                  <span className="block text-xs text-ink-muted">订单可在「我的订单」查看与管理</span>
                </span>
              </Link>
              <button
                type="button"
                onClick={() => { setGuestChoice('guest'); setErrorMsg(null); }}
                className={`flex items-center gap-3 rounded-2xl border-2 p-3.5 text-left transition-all ${
                  guestChoice === 'guest'
                    ? 'border-brand bg-brand-50 shadow-card'
                    : 'border-slate-200 bg-surface hover:border-brand/50 hover:bg-brand-50/50'
                }`}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand">
                  <Icon name="arrowRight" className="h-5 w-5" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-ink">以游客身份继续</span>
                  <span className="block text-xs text-ink-muted">凭「订单号 + 手机号」在『查订单』查询进度</span>
                </span>
              </button>
            </div>
            {guestChoice === 'guest' && (
              <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-brand-700">
                <Icon name="check" className="h-3.5 w-3.5" /> 已选择游客下单，请在下方填写联系人信息（手机号必填）
              </p>
            )}
          </section>
        )}

        {/* 订单内容摘要 */}
        <section className="card">
          <h2 className="section-title text-base">订单内容</h2>
          <ul className="mt-4 divide-y divide-slate-100">
            {items.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2.5 text-sm first:pt-0">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand">
                  <Icon
                    name={({ BUNDLE: 'package', FLIGHT: 'plane', HOTEL: 'hotel', VISA: 'visa', TRANSFER: 'car' } as const)[i.kind as 'BUNDLE' | 'FLIGHT' | 'HOTEL' | 'VISA' | 'TRANSFER'] ?? 'package'}
                    className="h-5 w-5"
                  />
                </span>
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
          {/* A5 优惠码：可见但暂不可用（后端无促销端点，不伪造折扣） */}
          <div className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-canvas px-3.5 py-3">
            <label className="label text-xs" htmlFor="promo-code">优惠码</label>
            <div className="mt-1 flex items-center gap-2">
              <input
                id="promo-code"
                className="input flex-1"
                placeholder="输入优惠码"
                value={promoCode}
                onChange={(e) => setPromoCode(e.target.value)}
                aria-describedby="promo-hint"
              />
              <button
                type="button"
                disabled
                className="btn-secondary shrink-0 cursor-not-allowed opacity-60"
                title="优惠码功能即将上线"
              >
                使用
              </button>
            </div>
            <p id="promo-hint" className="mt-1.5 flex items-center gap-1 text-xs text-ink-muted">
              <Icon name="clock" className="h-3 w-3" /> 优惠码暂不可用，敬请期待
            </p>
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-slate-200/80 pt-3">
            <span className="text-sm text-ink-soft">合计</span>
            <span className="price text-2xl">¥{fmt(total)}</span>
          </div>
        </section>

        {/* 联系人 */}
        <section className="card">
          <h2 className="section-title text-base">联系人信息</h2>
          {!isLoggedIn && guestChoice === 'guest' && (
            <p className="mt-1 text-xs text-ink-muted">
              游客下单：请确保手机号准确 —— 后续查订单、接收确认短信都用它。
            </p>
          )}
          <div className="mt-4 grid gap-2 sm:gap-3 md:grid-cols-3">
            <div>
              <label className="label">姓名 *</label>
              <input
                className="input"
                required
                autoComplete="name"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
              />
            </div>
            <div>
              <label className="label">手机号 *</label>
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                className={`input ${contactPhone && !isLikelyPhone(contactPhone) ? 'border-deal/60' : ''}`}
                required
                placeholder="如 +853 6234 5678"
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
              />
              {contactPhone && !isLikelyPhone(contactPhone) && (
                <p className="mt-1 text-xs font-medium text-deal">请输入 7–15 位有效手机号</p>
              )}
            </div>
            <div>
              <label className="label">邮箱（选填）</label>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
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
                expiryRequired={expiryRequired}
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

          {/* D2 安心保障 + 退改徽章；并诚实说明当前线下确认流程（非即时在线扣款） */}
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <RefundBadge />
              <span className="badge border border-brand-200 bg-brand-50 text-brand-700">
                <Icon name="shield" className="h-3 w-3" />
                提交即锁价 · 客服确认收款
              </span>
            </div>
            <div className="flex items-start gap-2 rounded-2xl border border-sun/40 bg-sun-light px-4 py-3 text-sm text-amber-800">
              <Icon name="info" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                提交后订单状态为 <strong>待确认</strong>，客服将联系确认收款（暂为线下确认流程，<strong>不会</strong>立即在线扣款）。请保持手机畅通。
              </span>
            </div>
            <TrustBadges variant="checkout" />
          </div>
        </section>

        {/* 预订须知 / 扣损规则 / 值机提示（纯展示，提交逻辑不动） */}
        <BookingNotices />

        {/* 手机端紧凑：返回 / 合计 + 按钮 在 360px 屏幕也不挤 */}
        <div className="sticky bottom-[calc(56px+env(safe-area-inset-bottom))] z-40 rounded-2xl border border-slate-200/80 bg-surface/95 px-3 py-2.5 shadow-pop backdrop-blur-xl sm:bottom-4 sm:px-4 sm:py-3">
          <div className="flex items-center justify-between gap-2 sm:gap-4">
            <Link to="/cart" className="whitespace-nowrap text-xs font-medium text-ink-muted transition hover:text-brand-700 sm:text-sm">
              ← <span className="hidden sm:inline">返回</span>购物车
            </Link>
            <div className="flex flex-1 items-center justify-end gap-2 sm:flex-none sm:gap-4">
              <span className="whitespace-nowrap text-sm text-ink-soft sm:text-base">
                合计 <span className="price text-xl align-middle sm:text-2xl">¥{fmt(total)}</span>
              </span>
              <button type="submit" className="btn-deal whitespace-nowrap px-4 text-sm sm:px-6 sm:text-base" disabled={submitting}>
                {submitting ? '提交中…' : !isLoggedIn && guestChoice === 'guest' ? '游客提交订单' : '提交订单'}
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// CheckoutSteps — A5 三步进度条（纯展示，反映现有单页流程，不改变流程本身）
// 单页结算里三步同屏，这里只是把心智模型显性化：确认信息 → 填写出行人 → 提交。
// ─────────────────────────────────────────────────────────────────
const CHECKOUT_STEPS = ['确认信息', '填写出行人', '提交'] as const;

function CheckoutSteps() {
  return (
    <ol className="mt-4 flex items-center gap-1.5 sm:gap-2" aria-label="结算步骤">
      {CHECKOUT_STEPS.map((label, idx) => (
        <li key={label} className="flex flex-1 items-center gap-1.5 sm:gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand-700 nums">
            {idx + 1}
          </span>
          <span className="truncate text-xs font-medium text-ink-soft sm:text-sm">{label}</span>
          {idx < CHECKOUT_STEPS.length - 1 && (
            <span className="h-px flex-1 bg-slate-200" aria-hidden />
          )}
        </li>
      ))}
    </ol>
  );
}

function PassengerCard({
  idx,
  passenger,
  expiryRequired,
  onChange,
  onRemove,
}: {
  idx: number;
  passenger: PassengerForm;
  /** 证件有效期是否必填（含机票/套餐/签证的单为真；纯酒店/接送单选填） */
  expiryRequired: boolean;
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

    // 读取图片为 data-URL（顺带压缩），用于预览 + 落库
    let photoDataUrl: string | undefined;
    try {
      const url = await passportFileToDataUrl(file);
      // 压缩后仍超限则 passportFileToDataUrl 返回 ''，不存
      if (url) {
        photoDataUrl = url;
        setImagePreview(url);
      }
    } catch {
      // 读取失败不阻断 OCR
    }

    try {
      const result = await ocrPassport(file, (pct, label) => {
        setOcrStage({ pct, label });
      });

      if (result.success) {
        // 填入识别结果。性别/护照有效期/签发国只在 MRZ 命中时由 OCR 带出（result.suggested 有值才覆盖），
        // 这样实现了「只在 OCR 时全采集，不增加手填负担」——这几项不渲染成可填输入框，只读展示。
        onChange({
          fullName: result.suggested.fullName || passenger.fullName,
          passportNumber: result.suggested.passportNumber || passenger.passportNumber,
          dateOfBirth: result.suggested.dateOfBirth || passenger.dateOfBirth,
          nationality: result.suggested.nationality || passenger.nationality,
          gender: result.suggested.gender ?? passenger.gender,
          passportExpiry: result.suggested.passportExpiry ?? passenger.passportExpiry,
          passportIssueCountry: result.suggested.passportIssueCountry ?? passenger.passportIssueCountry,
          passportIssuePlace: result.suggested.passportIssuePlace ?? passenger.passportIssuePlace,
          // 护照图落库：OCR 成功时一并存入
          ...(photoDataUrl ? { passportPhotoUrl: photoDataUrl } : {}),
        });
        setOcrResult({
          ok: true,
          msg: `✅ OCR 识别成功（${(result.elapsedMs / 1000).toFixed(1)}s · 置信度 ${result.confidence.toFixed(0)}%${result.mrz ? ' · MRZ 命中' : ''}）— 请核对关键字段`,
          preview: result.rawText.slice(0, 120),
        });
      } else {
        // 识别失败，但给出部分兜底结果；图片仍然落库（签证台需要原图）
        const patch: Partial<typeof passenger> = {};
        if (result.fallback?.passportNumber || result.fallback?.chineseName) {
          patch.fullName = result.fallback.englishName || result.fallback.chineseName || passenger.fullName;
          patch.passportNumber = result.fallback.passportNumber || passenger.passportNumber;
          patch.dateOfBirth = result.fallback.dateOfBirth || passenger.dateOfBirth;
        }
        if (photoDataUrl) patch.passportPhotoUrl = photoDataUrl;
        if (Object.keys(patch).length > 0) onChange(patch);
        setOcrResult({
          ok: false,
          msg: '⚠️ OCR 部分识别（未匹配 MRZ 标准），请手工核对并补全字段',
          preview: result.rawText.slice(0, 120) || result.error,
        });
      }
    } catch (err) {
      // OCR 报错时图片仍存入（签证台仍可查看）
      if (photoDataUrl) onChange({ passportPhotoUrl: photoDataUrl });
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
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            className={`input ${passenger.phone && !isLikelyPhone(passenger.phone) ? 'border-deal/60' : ''}`}
            required
            value={passenger.phone}
            onChange={(e) => onChange({ phone: e.target.value })}
            placeholder="紧急联系电话"
          />
          {passenger.phone && !isLikelyPhone(passenger.phone) && (
            <p className="mt-1 text-xs font-medium text-deal">请输入 7–15 位有效号码</p>
          )}
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
          <label className="label text-xs">
            证件有效期 {expiryRequired ? '*' : '（选填）'}（护照资料页「有效期至」）
          </label>
          <input
            type="date"
            className="input"
            required={expiryRequired}
            value={passenger.passportExpiry ?? ''}
            onChange={(e) => onChange({ passportExpiry: e.target.value })}
          />
          {expiryNotice(passenger.passportExpiry) && (
            <p className="mt-1 text-xs font-medium text-amber-700">
              {expiryNotice(passenger.passportExpiry)}
            </p>
          )}
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
        <div>
          <label className="label text-xs">护照签发地点（选填）</label>
          <input
            className="input"
            value={passenger.passportIssuePlace ?? ''}
            onChange={(e) => onChange({ passportIssuePlace: e.target.value })}
            placeholder="如 广东省广州市（选填）"
          />
        </div>
      </div>
      {/* OCR 已识别的护照附加信息（性别 / 签发地）——只读展示，不作必填字段。
          只在上传护照 OCR 命中 MRZ 时出现；没识别到就不显示，手填用户完全看不到、也不用管。
          证件有效期已升级为上方可填必填项，这里不再重复展示。 */}
      {(passenger.gender || passenger.passportIssueCountry || passenger.passportIssuePlace) && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-brand-200/70 bg-brand-50/50 px-3 py-2 text-xs text-brand-800">
          <span className="inline-flex items-center gap-1 font-medium">
            <Icon name="check" className="h-3.5 w-3.5" /> OCR 已识别
          </span>
          {passenger.gender && (
            <span>性别 {passenger.gender === 'M' ? '男' : passenger.gender === 'F' ? '女' : '未注明'}</span>
          )}
          {(passenger.passportIssuePlace || passenger.passportIssueCountry) && (
            <span>签发地 {passenger.passportIssuePlace || passenger.passportIssueCountry}</span>
          )}
        </div>
      )}
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

