/**
 * 签证台 · ADMIN/STAFF — 签证履约按人送签 + 批量状态流转
 *
 * 数据源：backend/src/modules/fulfillment/*
 *   GET   /fulfillment-tasks?type=VISA_APPLICATION&status=          任务列表（含 passengers[]）
 *   POST  /fulfillment-tasks/visa-passengers/batch-status          按人批量标记送签进度
 *   POST  /fulfillment-tasks/batch-notes                           批量改备注（部分失败返回 failures）
 *   GET   /orders/:id/passport-photos.zip                          下载护照包（送签用）
 *
 * 交互要点（签证岗反馈）：
 *   · 乘客默认平铺展示（姓名 / 护照号 / 护照有效期 / 缺照徽标），不必逐单点开，避免漏/误点。
 *   · 一单多人可只送其中几人：勾选到「人」，批量标记「材料准备 / 已送签」；订单行显示「已送 x/y」。
 *   · 全选订单 = 选中其下全部乘客。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  ApiError,
  type FulfillmentStatus,
  type FulfillmentTask,
  type ListFulfillmentParams,
  type VisaSubmissionStatus,
  type VisaTaskCostInput,
  type VisaTaskPassenger,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { localYmd } from '../lib/airports';

// 任务级签证状态文案（派生自乘客送签进度）
const VISA_STATUS_LABEL: Record<FulfillmentStatus, string> = {
  PENDING: '待处理',
  IN_PROGRESS: '已送签材料准备',
  CONFIRMED: '已送签',
  CANCELLED: '已取消',
  FAILED: '失败',
};

const VISA_STATUS_BADGE: Record<FulfillmentStatus, string> = {
  PENDING: 'badge-neutral',
  IN_PROGRESS: 'badge-info',
  CONFIRMED: 'badge-success',
  CANCELLED: 'badge-neutral',
  FAILED: 'badge-danger',
};

// 乘客送签进度文案 / 徽章（三档）
const SUBMISSION_LABEL: Record<VisaSubmissionStatus, string> = {
  PENDING: '待处理',
  IN_PROGRESS: '材料准备',
  CONFIRMED: '已送签',
};
const SUBMISSION_BADGE: Record<VisaSubmissionStatus, string> = {
  PENDING: 'badge-neutral',
  IN_PROGRESS: 'badge-info',
  CONFIRMED: 'badge-success',
};

// 按人批量标记的目标进度（签证台只做「材料准备 / 已送签」两档）
const BATCH_TARGETS: Array<{ value: VisaSubmissionStatus; label: string }> = [
  { value: 'IN_PROGRESS', label: '已送签材料准备' },
  { value: 'CONFIRMED', label: '已送签' },
];

// 按人批量：一次「全选」可能带出很多乘客，前端上限与后端（500）一致
const PASSENGER_BATCH_LIMIT = 500;
// 任务级批量备注上限（与后端 batch-notes 一致）
const NOTES_BATCH_LIMIT = 100;
// 列表单页拉取上限（与后端一致）
const PAGE_SIZE = 200;
const PAGE_SIZE_OPTIONS = [20, 30, 40, 50] as const;
const DEFAULT_PAGE_SIZE = 50;
// 护照有效期临期阈值：距今 < 6 个月标黄
const EXPIRY_SOON_MONTHS = 6;

// 状态筛选：OPEN = 待处理 + 材料准备（默认）；ALL = 全部
type StatusFilter = 'OPEN' | 'ALL' | FulfillmentStatus;

const STATUS_FILTER_PARAM: Record<StatusFilter, string | undefined> = {
  OPEN: 'PENDING,IN_PROGRESS',
  ALL: undefined,
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  CONFIRMED: 'CONFIRMED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
};

const FILTER_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'OPEN', label: '待办（待处理 + 材料准备，默认）' },
  { value: 'PENDING', label: '仅待处理' },
  { value: 'CONFIRMED', label: '已送签' },
  { value: 'ALL', label: '全部状态' },
];

// 签证签发方式筛选（走后端 issuanceMethod 参数；'NONE' = 未标注，'' = 全部不筛）
type IssuanceFilter = '' | 'E_VISA' | 'STICKER' | 'ARRIVAL' | 'NONE';

const ISSUANCE_FILTER_OPTIONS: Array<{ value: IssuanceFilter; label: string }> = [
  { value: '', label: '全部' },
  { value: 'E_VISA', label: '电子签' },
  { value: 'STICKER', label: '贴纸签' },
  { value: 'ARRIVAL', label: '落地签' },
  { value: 'NONE', label: '未标注' },
];

/**
 * 类型徽章的证据档位（后端 visaIssuanceSource/visaEntrySource 随任务下发）：
 *   PRODUCT      产品结构化标注 → 实色（确证）
 *   ORDER_STATUS 录单状态回退   → 浅色 +「·录单」（推断）
 *   NAME_GUESS   产品名正则猜测 → 浅色 +「·推测」（猜测）
 */
type BadgeEvidence = 'PRODUCT' | 'ORDER_STATUS' | 'NAME_GUESS';
const EVIDENCE_STYLE: Record<BadgeEvidence, { suffix: string; className: string; title: string }> = {
  PRODUCT: { suffix: '', className: 'badge-neutral text-[10px]', title: '签证产品已结构化标注' },
  ORDER_STATUS: {
    suffix: '·录单',
    className: 'badge-neutral text-[10px] opacity-60',
    title: '按录单「签证状态」推断，签证产品未结构化标注',
  },
  NAME_GUESS: {
    suffix: '·推测',
    className: 'badge-neutral text-[10px] opacity-60',
    title: '按产品名推测，未结构化标注',
  },
};

/** 护照有效期临期判定：null=未录入(false)；< 今日 = 已过期；< 今日+6月 = 临期 */
type ExpiryLevel = 'ok' | 'soon' | 'expired' | 'unknown';
function expiryLevel(ymd: string | null | undefined): ExpiryLevel {
  if (!ymd) return 'unknown';
  const exp = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(exp.getTime())) return 'unknown';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (exp < today) return 'expired';
  const threshold = new Date(today);
  threshold.setMonth(threshold.getMonth() + EXPIRY_SOON_MONTHS);
  return exp <= threshold ? 'soon' : 'ok';
}

/** 乘客送签进度（缺省视为 PENDING，兼容旧后端 payload） */
function subStatus(p: VisaTaskPassenger): VisaSubmissionStatus {
  return p.visaSubmissionStatus ?? 'PENDING';
}

/** 出行人签证日期三项（出签日/生效日/有效期）；null = 该字段未录入 */
interface PassengerVisaDates {
  visaIssueDate: string | null;
  visaEffectiveDate: string | null;
  visaExpiry: string | null;
}

// ── 平铺乘客行：勾选 + 姓名 / 护照号 / 护照有效期 / 缺照徽标 + 送签进度 ─────────────
interface PassengerRowProps {
  passenger: VisaTaskPassenger;
  selected: boolean;
  onToggleSelect: () => void;
  /** 展开后按需拉取到的护照大图（覆盖列表里的 null） */
  photoUrl?: string | null;
  photosLoading?: boolean;
  onRequestPhotos?: () => void;
  /** 签证日期编辑区是否显示（订单级「签证日期」开关控制） */
  showVisaDates?: boolean;
  visaDates?: PassengerVisaDates;
  visaDatesLoading?: boolean;
  onSaveVisaDates?: (passengerId: string, next: PassengerVisaDates) => Promise<void>;
}
function PassengerRow({
  passenger,
  selected,
  onToggleSelect,
  photoUrl,
  photosLoading,
  onRequestPhotos,
  showVisaDates,
  visaDates,
  visaDatesLoading,
  onSaveVisaDates,
}: PassengerRowProps) {
  const [enlarged, setEnlarged] = useState(false);
  const [editingVisaDates, setEditingVisaDates] = useState(false);
  const [visaDraft, setVisaDraft] = useState<PassengerVisaDates>({
    visaIssueDate: null,
    visaEffectiveDate: null,
    visaExpiry: null,
  });
  const [savingVisaDates, setSavingVisaDates] = useState(false);
  const [visaDatesError, setVisaDatesError] = useState<string | null>(null);

  const startEditVisaDates = () => {
    setVisaDraft({
      visaIssueDate: visaDates?.visaIssueDate ?? null,
      visaEffectiveDate: visaDates?.visaEffectiveDate ?? null,
      visaExpiry: visaDates?.visaExpiry ?? null,
    });
    setVisaDatesError(null);
    setEditingVisaDates(true);
  };

  const saveVisaDates = async () => {
    if (!onSaveVisaDates || savingVisaDates) return;
    setSavingVisaDates(true);
    setVisaDatesError(null);
    try {
      await onSaveVisaDates(passenger.id, visaDraft);
      setEditingVisaDates(false);
    } catch (e: unknown) {
      setVisaDatesError(e instanceof ApiError ? e.message : '保存失败，请重试');
    } finally {
      setSavingVisaDates(false);
    }
  };

  const visaDatesParts = visaDates
    ? [
        visaDates.visaIssueDate ? `出签日 ${visaDates.visaIssueDate}` : null,
        visaDates.visaEffectiveDate ? `生效日 ${visaDates.visaEffectiveDate}` : null,
        visaDates.visaExpiry ? `有效期 ${visaDates.visaExpiry}` : null,
      ].filter((x): x is string => Boolean(x))
    : [];
  const resolvedPhoto = photoUrl ?? passenger.passportPhotoUrl;

  const openPassport = () => {
    if (!resolvedPhoto) onRequestPhotos?.();
    setEnlarged(true);
  };

  const displayName =
    passenger.lastName && passenger.firstName
      ? `${passenger.lastName}/${passenger.firstName}`.toUpperCase()
      : passenger.fullName || '—';
  const genderLabel =
    passenger.gender === 'M'
      ? '男'
      : passenger.gender === 'F'
        ? '女'
        : passenger.gender === 'X'
          ? '其他'
          : null;

  const status = subStatus(passenger);
  const expLevel = expiryLevel(passenger.passportExpiry);

  return (
    <div
      className={`flex items-center gap-3 py-1.5 text-xs ${selected ? 'bg-brand-50/60 -mx-2 px-2 rounded' : ''}`}
    >
      {/* 按人勾选（部分送签） */}
      <input
        type="checkbox"
        className="shrink-0"
        aria-label={`选择乘客 ${displayName}`}
        checked={selected}
        onChange={onToggleSelect}
      />

      {/* 护照缺照/查看徽标（点击按需拉图） */}
      <div className="w-8 shrink-0">
        {photosLoading && !resolvedPhoto ? (
          <div className="flex h-8 w-8 items-center justify-center rounded border border-slate-200 bg-slate-50">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          </div>
        ) : resolvedPhoto ? (
          <button
            type="button"
            onClick={openPassport}
            title="点击查看护照大图核对信息"
            className="block h-8 w-8 overflow-hidden rounded border border-slate-200 hover:opacity-80 transition-opacity"
          >
            <img src={resolvedPhoto} alt={`${passenger.fullName} 护照`} className="h-full w-full object-cover" />
          </button>
        ) : passenger.hasPhoto ? (
          <button
            type="button"
            onClick={openPassport}
            title="点击查看护照大图核对信息"
            className="flex h-8 w-8 items-center justify-center rounded border border-slate-200 bg-slate-50 text-[9px] text-ink-muted hover:opacity-80"
          >
            照
          </button>
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded border border-rose-200 bg-rose-50 text-[9px] font-semibold text-rose-600">
            缺
          </div>
        )}
      </div>
      {resolvedPhoto && (
        <a
          href={resolvedPhoto}
          download={`passport-${passenger.documentNumber}.jpg`}
          className="btn-secondary shrink-0 py-0.5 px-1.5 text-[10px]"
          onClick={(e) => e.stopPropagation()}
        >
          下载护照
        </a>
      )}

      {/* 姓名 / 护照号 / 护照有效期 */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-ink truncate">{displayName}</span>
          {passenger.chineseName && (
            <span className="text-ink-muted truncate">{passenger.chineseName}</span>
          )}
          <span className="badge-neutral shrink-0 text-[10px]">{genderLabel ?? '—'}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className="font-mono text-ink-muted truncate">{passenger.documentNumber || '—'}</span>
          {/* 护照有效期：临期<6月标黄，已过期标红，未录入灰 */}
          {passenger.passportExpiry ? (
            <span
              className={
                expLevel === 'expired'
                  ? 'text-[11px] font-semibold text-rose-600'
                  : expLevel === 'soon'
                    ? 'text-[11px] font-semibold text-amber-600'
                    : 'text-[11px] text-ink-muted'
              }
              title={
                expLevel === 'expired'
                  ? '护照已过期'
                  : expLevel === 'soon'
                    ? `护照将在 ${EXPIRY_SOON_MONTHS} 个月内到期`
                    : '护照有效期'
              }
            >
              护照有效期 {passenger.passportExpiry}
              {expLevel === 'expired' ? '（已过期）' : expLevel === 'soon' ? '（临期）' : ''}
            </span>
          ) : (
            <span className="text-[11px] text-ink-muted">护照有效期未录入</span>
          )}
        </div>

        {/* 签证日期编辑（订单级开关开启时显示；出签后补录） */}
        {showVisaDates &&
          (editingVisaDates ? (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <label className="flex items-center gap-1 text-[10px] text-ink-muted">
                出签日
                <input
                  type="date"
                  className="input w-[9.5rem] py-0.5 text-[11px]"
                  value={visaDraft.visaIssueDate ?? ''}
                  onChange={(e) => setVisaDraft((d) => ({ ...d, visaIssueDate: e.target.value || null }))}
                  disabled={savingVisaDates}
                />
              </label>
              <label className="flex items-center gap-1 text-[10px] text-ink-muted">
                生效日
                <input
                  type="date"
                  className="input w-[9.5rem] py-0.5 text-[11px]"
                  value={visaDraft.visaEffectiveDate ?? ''}
                  onChange={(e) => setVisaDraft((d) => ({ ...d, visaEffectiveDate: e.target.value || null }))}
                  disabled={savingVisaDates}
                />
              </label>
              <label className="flex items-center gap-1 text-[10px] text-ink-muted">
                有效期
                <input
                  type="date"
                  className="input w-[9.5rem] py-0.5 text-[11px]"
                  value={visaDraft.visaExpiry ?? ''}
                  onChange={(e) => setVisaDraft((d) => ({ ...d, visaExpiry: e.target.value || null }))}
                  disabled={savingVisaDates}
                />
              </label>
              <button
                type="button"
                className="btn-primary py-0.5 px-2 text-[10px]"
                onClick={() => void saveVisaDates()}
                disabled={savingVisaDates}
              >
                {savingVisaDates ? '保存中…' : '保存'}
              </button>
              <button
                type="button"
                className="btn-ghost py-0.5 px-2 text-[10px]"
                onClick={() => setEditingVisaDates(false)}
                disabled={savingVisaDates}
              >
                取消
              </button>
              {visaDatesError && <span className="text-[10px] text-rose-600">{visaDatesError}</span>}
            </div>
          ) : (
            <div className="mt-0.5 flex items-center gap-1.5">
              {visaDatesLoading && visaDates === undefined ? (
                <span className="text-[10px] text-ink-muted">签证日期加载中…</span>
              ) : visaDatesParts.length > 0 ? (
                <span className="truncate text-[10px] text-ink-muted" title={visaDatesParts.join(' · ')}>
                  {visaDatesParts.join(' · ')}
                </span>
              ) : (
                <span className="text-[10px] text-ink-muted">未录入签证日期</span>
              )}
              {onSaveVisaDates && visaDates !== undefined && (
                <button
                  type="button"
                  className="shrink-0 text-[10px] text-brand hover:text-brand-dark hover:underline"
                  onClick={startEditVisaDates}
                >
                  编辑
                </button>
              )}
            </div>
          ))}
      </div>

      {/* 送签进度徽章（按人） */}
      <span className={`${SUBMISSION_BADGE[status]} shrink-0 text-[10px]`}>{SUBMISSION_LABEL[status]}</span>

      {/* 护照大图查看 */}
      {enlarged && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setEnlarged(false)}
        >
          <div
            className="relative flex max-h-[90vh] max-w-[90vw] flex-col items-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 max-w-full truncate text-center text-sm font-medium text-white">
              {displayName}
              {passenger.chineseName ? ` · ${passenger.chineseName}` : ''}
              {passenger.documentNumber ? ` · ${passenger.documentNumber}` : ''}
            </div>
            {resolvedPhoto ? (
              <img
                src={resolvedPhoto}
                alt={`${passenger.fullName} 护照`}
                className="max-h-[80vh] max-w-[90vw] rounded-lg shadow-2xl"
              />
            ) : photosLoading ? (
              <div className="flex h-40 w-64 items-center justify-center gap-2 rounded-lg bg-white/10 text-sm text-white">
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                护照加载中…
              </div>
            ) : (
              <div className="flex h-40 w-64 items-center justify-center rounded-lg bg-white/10 px-4 text-center text-sm text-white">
                护照图暂时无法加载，请收起后重试
              </div>
            )}
            <div className="mt-3 flex justify-center gap-3">
              {resolvedPhoto && (
                <a
                  href={resolvedPhoto}
                  download={`passport-${passenger.documentNumber}.jpg`}
                  className="btn-secondary text-xs py-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  下载此照片
                </a>
              )}
              <button
                type="button"
                className="btn-ghost text-xs py-1 text-white"
                onClick={() => setEnlarged(false)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 签证金额（人均实际成本）小控件 ─────────────────────────────────────────────
/** 解析输入框数字：空/非法 → null，有效有限数 → number */
function parseCostNum(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 展示态签证金额：$31.5 ×7.2=¥226.8/人 / ¥200/人 / 未设置 */
function visaCostSummary(task: FulfillmentTask): string {
  const cny = task.visaUnitCostCny;
  if (cny == null) return '未设置';
  if (task.visaUnitCostUsd != null && task.visaFxRate != null) {
    return `$${task.visaUnitCostUsd} ×${task.visaFxRate}=¥${cny}/人`;
  }
  return `¥${cny}/人`;
}

interface VisaCostControlProps {
  task: FulfillmentTask;
  token: string;
  /** 当日生效的美金汇率（来自汇率表）；未维护=null，此时汇率格留空由人手填 */
  defaultFxRate: number | null;
  onSaved: () => void;
}
/**
 * 签证人均成本 + 签证公司编辑：美金单价 × 汇率（自动折人民币）或直填人民币。
 * 汇率默认带出**当日生效汇率**（仍可手改）；折算值当场固化在任务上，
 * 之后财务改汇率表不会追溯本条。保存即调 setVisaTaskCost；清空三格保存 = 回退产品主数据成本。
 */
function VisaCostControl({ task, token, defaultFxRate, onSaved }: VisaCostControlProps) {
  const [editing, setEditing] = useState(false);
  const [usd, setUsd] = useState('');
  const [rate, setRate] = useState('');
  const [cny, setCny] = useState('');
  const [supplier, setSupplier] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 汇率格是否用了汇率表带出的默认值（给出「当日汇率」提示，避免用户以为是历史值）
  const [rateFromTable, setRateFromTable] = useState(false);

  const startEdit = () => {
    setUsd(task.visaUnitCostUsd != null ? String(task.visaUnitCostUsd) : '');
    // 本条已固化过汇率 → 原样回显（绝不被新汇率覆盖）；未设置过才带当日生效汇率
    if (task.visaFxRate != null) {
      setRate(String(task.visaFxRate));
      setRateFromTable(false);
    } else {
      setRate(defaultFxRate != null ? String(defaultFxRate) : '');
      setRateFromTable(defaultFxRate != null);
    }
    setCny(task.visaUnitCostCny != null ? String(task.visaUnitCostCny) : '');
    setSupplier(task.visaSupplier ?? '');
    setError(null);
    setEditing(true);
  };

  const usdNum = parseCostNum(usd);
  const rateNum = parseCostNum(rate);
  // 美金+汇率齐备 → 预览自动折算人民币（与后端口径一致）
  const autoCny =
    usdNum != null && rateNum != null ? Math.round(usdNum * rateNum * 100) / 100 : null;

  const save = async () => {
    let payload: VisaTaskCostInput;
    if (usdNum != null || rateNum != null) {
      // 想用美金折算：单价与汇率须同时给
      if (usdNum == null || rateNum == null) {
        setError('美金单价与汇率需同时填写');
        return;
      }
      if (usdNum < 0 || rateNum <= 0) {
        setError('美金单价需 ≥0，汇率需 >0');
        return;
      }
      payload = { visaUnitCostUsd: usdNum, visaFxRate: rateNum, visaUnitCostCny: null };
    } else {
      const cnyNum = parseCostNum(cny);
      if (cnyNum != null && cnyNum < 0) {
        setError('人民币金额需 ≥0');
        return;
      }
      // cnyNum 为 null（三格全空）= 清空回退产品成本
      payload = { visaUnitCostUsd: null, visaFxRate: null, visaUnitCostCny: cnyNum };
    }
    // 签证公司与金额同一次提交（后端两者互相独立）；空串 = 清空
    payload.visaSupplier = supplier.trim();
    setSaving(true);
    setError(null);
    try {
      await api.setVisaTaskCost(token, task.id, payload);
      setEditing(false);
      onSaved();
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="flex flex-col items-center gap-0.5">
        {/* 签证公司（财务对账用）——此前只能塞备注里，现在单列一行 */}
        <span
          className={
            task.visaSupplier ? 'text-[11px] text-ink-soft' : 'text-[11px] text-ink-muted'
          }
          title="签证公司（本次送签的供应商）"
        >
          {task.visaSupplier ? `签证公司：${task.visaSupplier}` : '签证公司未填'}
        </span>
        <span
          className={
            task.visaUnitCostCny != null
              ? 'text-[11px] font-medium text-ink'
              : 'text-[11px] text-ink-muted'
          }
        >
          {visaCostSummary(task)}
        </span>
        <button type="button" className="btn-ghost py-0.5 px-2 text-[11px]" onClick={startEdit}>
          {task.visaUnitCostCny != null || task.visaSupplier ? '改金额/公司' : '设金额/公司'}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-stretch gap-1 rounded-md border border-brand-200 bg-white p-2 text-left">
      <div className="flex items-center gap-1">
        <span className="whitespace-nowrap text-[11px] text-ink-muted">签证公司</span>
        <input
          className="input w-32 py-0.5 text-xs"
          placeholder="如 XX签证服务"
          value={supplier}
          disabled={saving}
          onChange={(e) => setSupplier(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-1">
        <span className="text-[11px] text-ink-muted">$</span>
        <input
          className="input w-16 py-0.5 text-xs"
          inputMode="decimal"
          placeholder="美金"
          value={usd}
          disabled={saving}
          onChange={(e) => setUsd(e.target.value)}
        />
        <span className="text-[11px] text-ink-muted">×</span>
        <input
          className="input w-16 py-0.5 text-xs"
          inputMode="decimal"
          placeholder="汇率"
          value={rate}
          disabled={saving}
          onChange={(e) => setRate(e.target.value)}
        />
      </div>
      {rateFromTable && (
        <div className="text-[10px] text-ink-muted">汇率已按当日汇率表带出，可手改</div>
      )}
      {autoCny != null && (
        <div className="text-[11px] text-emerald-700">= ¥{autoCny}/人（自动折算）</div>
      )}
      <div className="flex items-center gap-1">
        <span className="text-[11px] text-ink-muted">或 直填 ¥</span>
        <input
          className="input w-20 py-0.5 text-xs disabled:bg-slate-50"
          inputMode="decimal"
          placeholder="人民币"
          value={cny}
          // 已用美金折算时直填框失效（避免两套值打架）
          disabled={saving || usdNum != null || rateNum != null}
          onChange={(e) => setCny(e.target.value)}
        />
      </div>
      {error && <div className="text-[11px] text-rose-600">{error}</div>}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="btn-primary py-0.5 px-2 text-[11px]"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          className="btn-ghost py-0.5 px-2 text-[11px]"
          onClick={() => setEditing(false)}
          disabled={saving}
        >
          取消
        </button>
      </div>
      <p className="text-[10px] text-ink-muted">
        金额三格留空保存 = 清空，财务回退产品成本；签证公司留空 = 清空
      </p>
    </div>
  );
}

// ── 订单组：订单头行 + 平铺乘客行 ─────────────────────────────────────────────
interface OrderGroupProps {
  task: FulfillmentTask;
  rowNumber: number;
  hidden?: boolean;
  selectedPassengerIds: Set<string>;
  onTogglePassenger: (passengerId: string) => void;
  onToggleOrderPassengers: (passengerIds: string[]) => void;
  token: string;
  /** 当日生效的美金汇率（透传给签证金额控件做默认值）；未维护=null */
  defaultFxRate: number | null;
  onChanged: () => void;
}
function OrderGroup({
  task,
  rowNumber,
  hidden = false,
  selectedPassengerIds,
  onTogglePassenger,
  onToggleOrderPassengers,
  token,
  defaultFxRate,
  onChanged,
}: OrderGroupProps) {
  const passengers = task.passengers ?? [];
  const orderId = task.item.orderId;

  const [downloading, setDownloading] = useState(false);
  const [showVisaDates, setShowVisaDates] = useState(false);

  // 护照大图按需加载（点击缺照/照片徽标时才拉真图）
  const [photoMap, setPhotoMap] = useState<Record<string, string | null>>({});
  const [photosLoading, setPhotosLoading] = useState(false);
  const [photosError, setPhotosError] = useState<string | null>(null);
  const photosLoadedRef = useRef(false);

  // 备注 = 任务级 task.notes。显式保存（公测反馈：blur 自动保存让人「不知道在哪里保存/
  // 莫名其妙就修改了」）：有改动时出现「保存」按钮（或 Enter 提交），成功短暂显示「✓ 已保存」。
  const [noteDraft, setNoteDraft] = useState(task.notes ?? '');
  // 草稿的服务端基准值：dirty = 草稿 ≠ 基准。保存成功 / 轮询同步时更新。
  const [noteBaseline, setNoteBaseline] = useState(task.notes ?? '');
  const [savingNote, setSavingNote] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteFocusedRef = useRef(false);
  const noteSavedTimerRef = useRef<number | null>(null);
  const noteDirty = noteDraft.trim() !== noteBaseline;
  useEffect(() => {
    // 轮询刷新防覆盖：编辑中（聚焦）或有未保存改动时，绝不用服务端值刷掉本地草稿。
    const incoming = task.notes ?? '';
    if (incoming === noteBaseline) return;
    if (!noteFocusedRef.current && noteDraft.trim() === noteBaseline) {
      setNoteDraft(incoming);
    }
    setNoteBaseline(incoming);
  }, [task.notes, noteBaseline, noteDraft]);
  useEffect(
    () => () => {
      if (noteSavedTimerRef.current !== null) window.clearTimeout(noteSavedTimerRef.current);
    },
    [],
  );

  const loadPhotos = useCallback(() => {
    if (!orderId || passengers.length === 0) return;
    photosLoadedRef.current = true;
    setPhotosLoading(true);
    setPhotosError(null);
    api
      .listPassengerPhotos(token, orderId)
      .then((res) => {
        const m: Record<string, string | null> = {};
        for (const ph of res.photos) m[ph.id] = ph.passportPhotoUrl;
        setPhotoMap(m);
      })
      .catch((e: unknown) => {
        photosLoadedRef.current = false;
        setPhotosError(e instanceof ApiError ? e.message : '护照图加载失败');
      })
      .finally(() => setPhotosLoading(false));
  }, [orderId, passengers.length, token]);

  const ensurePhotos = useCallback(() => {
    if (!photosLoadedRef.current && !photosLoading) loadPhotos();
  }, [loadPhotos, photosLoading]);

  // 签证日期按需加载（点开「签证日期」时才拉订单详情）
  const [visaDatesMap, setVisaDatesMap] = useState<Record<string, PassengerVisaDates>>({});
  const [visaDatesLoading, setVisaDatesLoading] = useState(false);
  const [visaDatesLoadError, setVisaDatesLoadError] = useState<string | null>(null);
  const visaDatesLoadedRef = useRef(false);

  const loadVisaDates = useCallback(() => {
    if (!orderId || passengers.length === 0) return;
    visaDatesLoadedRef.current = true;
    setVisaDatesLoading(true);
    setVisaDatesLoadError(null);
    api
      .getOrder(token, orderId)
      .then((res) => {
        const m: Record<string, PassengerVisaDates> = {};
        for (const p of res.order.passengers ?? []) {
          m[p.id] = {
            visaIssueDate: p.visaIssueDate ?? null,
            visaEffectiveDate: p.visaEffectiveDate ?? null,
            visaExpiry: p.visaExpiry ?? null,
          };
        }
        setVisaDatesMap(m);
      })
      .catch((e: unknown) => {
        visaDatesLoadedRef.current = false;
        setVisaDatesLoadError(e instanceof ApiError ? e.message : '签证日期加载失败');
      })
      .finally(() => setVisaDatesLoading(false));
  }, [orderId, passengers.length, token]);

  const saveVisaDates = useCallback(
    async (passengerId: string, next: PassengerVisaDates) => {
      if (!orderId) throw new Error('缺少订单号，无法保存');
      await api.updatePassengerVisaDates(token, orderId, passengerId, next);
      setVisaDatesMap((prev) => ({ ...prev, [passengerId]: next }));
    },
    [orderId, token],
  );

  const toggleVisaDates = () => {
    const next = !showVisaDates;
    setShowVisaDates(next);
    if (next && !visaDatesLoadedRef.current) loadVisaDates();
  };

  // 出发日期（本地化）：纯签证单无航班 → null
  const departureYmd =
    task.order?.departureTime && task.order?.departureTz
      ? localYmd(task.order.departureTime, task.order.departureTz)
      : null;

  // 类型徽章（签发方式 / 入境次数，带证据出处）
  const visaName = task.visaName ?? '';
  const typeBadges: Array<{ key: string; text: string; evidence: BadgeEvidence }> = [];
  const entryLabel =
    task.visaEntryType === 'SINGLE' ? '单次' : task.visaEntryType === 'MULTIPLE' ? '多次' : null;
  if (entryLabel) {
    typeBadges.push({
      key: 'entry',
      text: entryLabel,
      evidence: task.visaEntrySource === 'ORDER_STATUS' ? 'ORDER_STATUS' : 'PRODUCT',
    });
  } else {
    const guess = /多次/.test(visaName) ? '多次' : /单次/.test(visaName) ? '单次' : null;
    if (guess) typeBadges.push({ key: 'entry', text: guess, evidence: 'NAME_GUESS' });
  }
  const issuanceLabel =
    task.visaIssuanceMethod === 'E_VISA'
      ? '电子签'
      : task.visaIssuanceMethod === 'STICKER'
        ? '贴纸签'
        : task.visaIssuanceMethod === 'ARRIVAL'
          ? '落地签'
          : null;
  if (issuanceLabel) {
    typeBadges.push({
      key: 'issuance',
      text: issuanceLabel,
      evidence: task.visaIssuanceSource === 'ORDER_STATUS' ? 'ORDER_STATUS' : 'PRODUCT',
    });
  }

  const saveNote = async () => {
    if (savingNote) return;
    const next = noteDraft.trim();
    if (next === noteBaseline) return;
    setSavingNote(true);
    setNoteError(null);
    setNoteSaved(false);
    try {
      await api.updateFulfillmentTask(token, task.id, { notes: next });
      // 立即收敛基准值：不等轮询回包就消掉「未保存」标识，并短暂显示成功提示。
      setNoteBaseline(next);
      setNoteDraft(next);
      setNoteSaved(true);
      if (noteSavedTimerRef.current !== null) window.clearTimeout(noteSavedTimerRef.current);
      noteSavedTimerRef.current = window.setTimeout(() => setNoteSaved(false), 2500);
      onChanged();
    } catch (e: unknown) {
      setNoteError(e instanceof ApiError ? e.message : '备注保存失败');
    } finally {
      setSavingNote(false);
    }
  };

  const handleDownloadZip = async () => {
    if (!orderId) return;
    setDownloading(true);
    try {
      const blob = await api.downloadPassportsZip(token, orderId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `passports-${task.order?.orderNumber ?? orderId}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      alert(e instanceof ApiError ? `下载失败：${e.message}` : '下载失败，请重试');
    } finally {
      setDownloading(false);
    }
  };

  // 进度：已送 x/y（x=已送签，y=乘客总数）；缺照数用于头行提示
  const total = passengers.length;
  const sentCount = passengers.filter((p) => subStatus(p) === 'CONFIRMED').length;
  const prepCount = passengers.filter((p) => subStatus(p) === 'IN_PROGRESS').length;
  const missingCount = passengers.filter((p) => !p.hasPhoto).length;

  // 订单级勾选：其下全部乘客是否全选 / 部分选
  const passengerIds = passengers.map((p) => p.id);
  const allSelected = passengerIds.length > 0 && passengerIds.every((id) => selectedPassengerIds.has(id));
  const someSelected = !allSelected && passengerIds.some((id) => selectedPassengerIds.has(id));

  return (
    <>
      <tr className={`${hidden ? 'hidden ' : ''}border-t-2 border-slate-200 bg-slate-50/60`}>
        <td className="align-top text-center">
          <input
            type="checkbox"
            aria-label={`选择订单 ${task.order?.orderNumber ?? task.id} 全部乘客`}
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected;
            }}
            onChange={() => onToggleOrderPassengers(passengerIds)}
          />
        </td>
        <td className="nums align-top text-center text-xs text-ink-muted">{rowNumber}</td>
        <td className="align-top font-mono text-xs text-ink">
          <div>
            {task.order?.orderNumber ? (
              <Link
                to={`/orders?q=${encodeURIComponent(task.order.orderNumber)}`}
                className="text-brand hover:text-brand-dark hover:underline"
                title="在订单管理中打开该订单"
              >
                {task.order.orderNumber}
              </Link>
            ) : (
              '—'
            )}
          </div>
          <div className="mt-0.5 font-sans text-[10px] text-ink-muted">出发 {departureYmd ?? '—'}</div>
        </td>
        {/* 进度：已送 x/y（+ 材料准备数） */}
        <td className="align-top text-right nums">
          <div className="text-xs font-semibold text-ink">
            已送 {sentCount}/{total}
          </div>
          {prepCount > 0 && (
            <div className="mt-0.5 text-[10px] text-sky-600">材料准备 {prepCount}</div>
          )}
        </td>
        <td className="align-top text-xs text-ink-muted">
          {/* 显式保存：blur 不再自动写库、也不丢输入；有改动时出现「保存」按钮（Enter 同效） */}
          <div className="flex items-center gap-1.5">
            <input
              className="input max-w-xs py-1 text-xs"
              value={noteDraft}
              placeholder="添加备注…"
              disabled={savingNote}
              onChange={(e) => setNoteDraft(e.target.value)}
              onFocus={() => {
                noteFocusedRef.current = true;
              }}
              onBlur={() => {
                noteFocusedRef.current = false;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void saveNote();
                }
              }}
            />
            {(noteDirty || savingNote) && (
              <button
                type="button"
                className="btn-secondary whitespace-nowrap py-0.5 px-2 text-xs"
                onClick={() => void saveNote()}
                disabled={savingNote}
              >
                {savingNote ? '保存中…' : '保存'}
              </button>
            )}
          </div>
          {noteDirty && !savingNote && (
            <div className="mt-0.5 text-[10px] text-amber-600">未保存</div>
          )}
          {noteSaved && !noteDirty && (
            <div className="mt-0.5 text-[10px] text-emerald-600">✓ 已保存</div>
          )}
          {noteError && <div className="mt-0.5 text-[10px] text-rose-600">{noteError}</div>}
        </td>
        <td className="align-top text-center">
          <span className={VISA_STATUS_BADGE[task.status]}>{VISA_STATUS_LABEL[task.status]}</span>
          {typeBadges.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center justify-center gap-1">
              {typeBadges.map((b) => {
                const style = EVIDENCE_STYLE[b.evidence];
                return (
                  <span key={b.key} className={style.className} title={style.title}>
                    {b.text}
                    {style.suffix}
                  </span>
                );
              })}
            </div>
          )}
        </td>
        <td className="align-top text-center">
          <div className="flex flex-col items-center gap-1">
            <button
              type="button"
              className="btn-secondary py-0.5 px-2 text-xs"
              onClick={() => void handleDownloadZip()}
              disabled={downloading}
            >
              {downloading ? '打包中…' : '下载护照'}
            </button>
            <button
              type="button"
              className="btn-ghost py-0.5 px-2 text-[11px]"
              onClick={toggleVisaDates}
              title="出签后补录签证日期"
            >
              {showVisaDates ? '收起签证日期' : '签证日期'}
            </button>
            {missingCount > 0 && <span className="badge-danger text-[10px]">缺照 {missingCount}</span>}
            {/* 签证公司 + 人均成本（签证公司按航班开美金账单；财务据此核对）*/}
            <div className="mt-1 border-t border-slate-200 pt-1">
              <VisaCostControl
                task={task}
                token={token}
                defaultFxRate={defaultFxRate}
                onSaved={onChanged}
              />
            </div>
          </div>
        </td>
      </tr>

      {/* 平铺乘客行（默认展示，不需点开） */}
      <tr className={hidden ? 'hidden' : ''}>
        <td colSpan={7} className="px-4 pb-3 pt-1">
          {passengers.length === 0 ? (
            <p className="text-xs text-ink-muted">无乘客数据</p>
          ) : (
            <>
              {photosError && (
                <div className="mb-2 flex items-center gap-2 text-xs text-rose-600">
                  <span>护照图加载失败：{photosError}</span>
                  <button type="button" className="btn-ghost py-0.5 px-2 text-xs" onClick={loadPhotos}>
                    重试
                  </button>
                </div>
              )}
              {showVisaDates && visaDatesLoadError && (
                <div className="mb-2 flex items-center gap-2 text-xs text-rose-600">
                  <span>签证日期加载失败：{visaDatesLoadError}</span>
                  <button type="button" className="btn-ghost py-0.5 px-2 text-xs" onClick={loadVisaDates}>
                    重试
                  </button>
                </div>
              )}
              <div className="max-w-2xl divide-y divide-slate-100">
                {passengers.map((p) => (
                  <PassengerRow
                    key={p.id}
                    passenger={p}
                    selected={selectedPassengerIds.has(p.id)}
                    onToggleSelect={() => onTogglePassenger(p.id)}
                    photoUrl={photoMap[p.id]}
                    photosLoading={photosLoading}
                    onRequestPhotos={ensurePhotos}
                    showVisaDates={showVisaDates}
                    visaDates={visaDatesMap[p.id]}
                    visaDatesLoading={visaDatesLoading}
                    onSaveVisaDates={saveVisaDates}
                  />
                ))}
              </div>
            </>
          )}
        </td>
      </tr>
    </>
  );
}

// ── 主页面 ────────────────────────────────────────────────────────────────────
export function VisaDeskPage() {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';

  const [tasks, setTasks] = useState<FulfillmentTask[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('OPEN');
  const [issuanceFilter, setIssuanceFilter] = useState<IssuanceFilter>('');
  // 出发日期区间（走后端 departureDateFrom/To）；空 = 不按出发日过滤
  const [departureFrom, setDepartureFrom] = useState('');
  const [departureTo, setDepartureTo] = useState('');
  // 备注搜索（走后端 notesQuery）；400ms 防抖
  const [notesQueryInput, setNotesQueryInput] = useState('');
  const [debouncedNotesQuery, setDebouncedNotesQuery] = useState('');
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [currentPage, setCurrentPage] = useState(1);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedNotesQuery(notesQueryInput.trim()), 400);
    return () => clearTimeout(t);
  }, [notesQueryInput]);

  const [rosterDownloading, setRosterDownloading] = useState(false);
  const [passportsDownloading, setPassportsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // ── 按人选择 / 流转 ─────────────────────────────────
  const [selectedPassengerIds, setSelectedPassengerIds] = useState<Set<string>>(new Set());
  const [batchTarget, setBatchTarget] = useState<VisaSubmissionStatus>('CONFIRMED');
  const [submitting, setSubmitting] = useState(false);
  const [batchResult, setBatchResult] = useState<{
    successCount: number;
    failureCount: number;
    failures: Array<{ id: string; error: string }>;
  } | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [batchNote, setBatchNote] = useState('');
  const [batchNoteSubmitting, setBatchNoteSubmitting] = useState(false);
  // 批量设签证金额（签证公司按航班统一单价是常态）
  const [batchCostUsd, setBatchCostUsd] = useState('');
  const [batchCostRate, setBatchCostRate] = useState('');
  const [batchCostCny, setBatchCostCny] = useState('');
  const [batchCostSubmitting, setBatchCostSubmitting] = useState(false);
  // 批量设签证公司（与金额独立提交：只应用公司不动金额）
  const [batchSupplier, setBatchSupplier] = useState('');
  const [batchSupplierSubmitting, setBatchSupplierSubmitting] = useState(false);

  /**
   * 当日生效的美金汇率（财务在财务页按生效日维护）。
   * 只做「默认值」：带进汇率输入框，仍可手改；折算值保存时固化在任务上，
   * 之后财务改汇率表不会追溯已入账的任务。未维护 → null，汇率格留空由人手填。
   */
  const [todayFxRate, setTodayFxRate] = useState<number | null>(null);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate(),
    ).padStart(2, '0')}`;
    api
      .getEffectiveUsdFxRate(token, ymd)
      .then((d) => {
        if (cancelled) return;
        const rate = d.rate?.rate ?? null;
        setTodayFxRate(rate);
        // 汇率表有值且用户还没动过输入框 → 预填批量汇率格（仍可手改）
        if (rate != null) setBatchCostRate((prev) => (prev === '' ? String(rate) : prev));
      })
      .catch(() => {
        // 静默：取不到汇率就让用户手填，不打断签证台主流程
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query: ListFulfillmentParams = {
      type: 'VISA_APPLICATION',
      status: STATUS_FILTER_PARAM[statusFilter],
      issuanceMethod: issuanceFilter || undefined,
      departureDateFrom: departureFrom || undefined,
      departureDateTo: departureTo || undefined,
      notesQuery: debouncedNotesQuery || undefined,
      pageSize: PAGE_SIZE,
    };
    api
      .listFulfillmentTasks(token, query)
      .then((res) => {
        if (cancelled) return;
        setTasks(res.tasks);
        setTotalCount(res.pagination?.total ?? res.tasks.length);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : '签证任务加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, statusFilter, issuanceFilter, departureFrom, departureTo, debouncedNotesQuery, refreshNonce]);

  // 筛选/每页数变化时回到第 1 页；备注输入变化时立即重置，防抖后也覆盖后端筛选生效的时点。
  useEffect(() => {
    setCurrentPage(1);
  }, [statusFilter, issuanceFilter, departureFrom, departureTo, notesQueryInput, debouncedNotesQuery, pageSize]);

  // 客户端按任务（订单）粒度分页；服务端仍一次最多返回 PAGE_SIZE 条任务。
  const totalPages = Math.max(1, Math.ceil(tasks.length / pageSize));
  const effectiveCurrentPage = Math.min(currentPage, totalPages);
  const pageStart = (effectiveCurrentPage - 1) * pageSize;
  // 当前页 ids 仍按 pageStart/pageSize 计算。tbody 保留全量 OrderGroup 挂载，仅隐藏非当前页行：
  // 今天本来就是平铺渲染全部任务（≤200 条），隐藏式分页不增加 DOM 成本；显式保存口径下，
  // 选择保留草稿不丢优先于虚拟化。
  const currentPageTasks = useMemo(
    () => tasks.slice(pageStart, pageStart + pageSize),
    [tasks, pageStart, pageSize],
  );

  // 当前页全部乘客 id + 乘客→任务/订单映射
  const visiblePassengerIds = useMemo(
    () => currentPageTasks.flatMap((t) => (t.passengers ?? []).map((p) => p.id)),
    [currentPageTasks],
  );
  const passengerToTask = useMemo(() => {
    const m = new Map<string, FulfillmentTask>();
    for (const t of tasks) for (const p of t.passengers ?? []) m.set(p.id, t);
    return m;
  }, [tasks]);

  const allVisibleSelected =
    visiblePassengerIds.length > 0 && visiblePassengerIds.every((id) => selectedPassengerIds.has(id));
  const someVisibleSelected =
    !allVisibleSelected && visiblePassengerIds.some((id) => selectedPassengerIds.has(id));

  const togglePassenger = (id: string) => {
    setSelectedPassengerIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // 订单级：切换其下全部乘客（全选/全不选，取决于是否已全选）
  const toggleOrderPassengers = (ids: string[]) => {
    setSelectedPassengerIds((prev) => {
      const next = new Set(prev);
      const allIn = ids.length > 0 && ids.every((id) => next.has(id));
      if (allIn) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  };
  const toggleAllVisible = () => {
    setSelectedPassengerIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visiblePassengerIds.forEach((id) => next.delete(id));
      else visiblePassengerIds.forEach((id) => next.add(id));
      return next;
    });
  };
  const clearSelection = useCallback(() => {
    setSelectedPassengerIds(new Set());
    setBatchResult(null);
  }, []);

  // 勾选乘客 → 去重订单 id（下载名单/护照用）
  const selectedOrderIds = useMemo(
    () =>
      Array.from(
        new Set(
          Array.from(selectedPassengerIds)
            .map((pid) => passengerToTask.get(pid)?.item.orderId)
            .filter((id): id is string => Boolean(id)),
        ),
      ),
    [selectedPassengerIds, passengerToTask],
  );
  // 勾选乘客 → 去重任务 id（批量备注用）
  const selectedTaskIds = useMemo(
    () =>
      Array.from(
        new Set(
          Array.from(selectedPassengerIds)
            .map((pid) => passengerToTask.get(pid)?.id)
            .filter((id): id is string => Boolean(id)),
        ),
      ),
    [selectedPassengerIds, passengerToTask],
  );

  const handleDownloadVisaRoster = async () => {
    if (!token || selectedOrderIds.length === 0 || rosterDownloading) return;
    setRosterDownloading(true);
    setDownloadError(null);
    try {
      const blob = await api.downloadVisaRoster(token, selectedOrderIds);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `签证名单_${selectedOrderIds.length}单.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setDownloadError(e instanceof ApiError ? e.message : '名单下载失败，请重试');
    } finally {
      setRosterDownloading(false);
    }
  };

  const handleDownloadVisaPassports = async () => {
    if (!token || selectedOrderIds.length === 0 || passportsDownloading) return;
    setPassportsDownloading(true);
    setDownloadError(null);
    try {
      const blob = await api.downloadVisaPassports(token, selectedOrderIds);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `签证护照_${selectedOrderIds.length}单.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setDownloadError(e instanceof ApiError ? e.message : '护照包下载失败，请重试');
    } finally {
      setPassportsDownloading(false);
    }
  };

  // 按人批量标记送签进度
  const applyBatch = async () => {
    if (!token || selectedPassengerIds.size === 0) return;
    if (selectedPassengerIds.size > PASSENGER_BATCH_LIMIT) {
      alert(
        `单次最多批量处理 ${PASSENGER_BATCH_LIMIT} 人，请分批操作（当前已选 ${selectedPassengerIds.size} 人）`,
      );
      return;
    }
    const targetLabel = SUBMISSION_LABEL[batchTarget];
    if (!window.confirm(`将 ${selectedPassengerIds.size} 名乘客标记为「${targetLabel}」？`)) return;
    setSubmitting(true);
    setBatchResult(null);
    try {
      const res = await api.batchUpdateVisaPassengerStatus(
        token,
        Array.from(selectedPassengerIds),
        batchTarget,
      );
      setBatchResult(res);
      if (res.failureCount === 0) setSelectedPassengerIds(new Set());
      setRefreshNonce((n) => n + 1);
    } catch (e: unknown) {
      alert(e instanceof ApiError ? `批量操作失败：${e.message}` : '批量操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  // 批量备注：作用于所选乘客所属订单的签证任务（去重后按任务改）
  const applyBatchNote = async () => {
    if (!token || selectedTaskIds.length === 0 || batchNoteSubmitting) return;
    if (selectedTaskIds.length > NOTES_BATCH_LIMIT) {
      alert(`单次最多批量备注 ${NOTES_BATCH_LIMIT} 单，请分批操作（当前涉及 ${selectedTaskIds.length} 单）`);
      return;
    }
    const next = batchNote.trim();
    if (
      !window.confirm(
        `将覆盖所选 ${selectedTaskIds.length} 单的现有备注为「${next || '（空）'}」？此操作不可撤销。`,
      )
    )
      return;
    setBatchNoteSubmitting(true);
    setBatchResult(null);
    try {
      const res = await api.batchUpdateFulfillmentNotes(token, selectedTaskIds, next);
      setBatchResult(res);
      if (res.failureCount === 0) setBatchNote('');
      setRefreshNonce((n) => n + 1);
    } catch (e: unknown) {
      alert(e instanceof ApiError ? `批量备注失败：${e.message}` : '批量备注失败');
    } finally {
      setBatchNoteSubmitting(false);
    }
  };

  // 批量设签证金额：作用于所选乘客所属订单的签证任务（去重后按任务设同一人均单价）
  const batchCostUsdNum = parseCostNum(batchCostUsd);
  const batchCostRateNum = parseCostNum(batchCostRate);
  const batchCostAutoCny =
    batchCostUsdNum != null && batchCostRateNum != null
      ? Math.round(batchCostUsdNum * batchCostRateNum * 100) / 100
      : null;
  const applyBatchCost = async () => {
    if (!token || selectedTaskIds.length === 0 || batchCostSubmitting) return;
    if (selectedTaskIds.length > NOTES_BATCH_LIMIT) {
      alert(`单次最多批量处理 ${NOTES_BATCH_LIMIT} 单，请分批操作（当前涉及 ${selectedTaskIds.length} 单）`);
      return;
    }
    let payload: VisaTaskCostInput;
    let label: string;
    if (batchCostUsdNum != null || batchCostRateNum != null) {
      if (batchCostUsdNum == null || batchCostRateNum == null) {
        alert('美金单价与汇率需同时填写');
        return;
      }
      if (batchCostUsdNum < 0 || batchCostRateNum <= 0) {
        alert('美金单价需 ≥0，汇率需 >0');
        return;
      }
      payload = {
        visaUnitCostUsd: batchCostUsdNum,
        visaFxRate: batchCostRateNum,
        visaUnitCostCny: null,
      };
      label = `$${batchCostUsdNum} ×${batchCostRateNum}=¥${batchCostAutoCny}/人`;
    } else {
      const cnyNum = parseCostNum(batchCostCny);
      if (cnyNum != null && cnyNum < 0) {
        alert('人民币金额需 ≥0');
        return;
      }
      payload = { visaUnitCostUsd: null, visaFxRate: null, visaUnitCostCny: cnyNum };
      label = cnyNum != null ? `¥${cnyNum}/人` : '清空（回退产品成本）';
    }
    if (
      !window.confirm(`将所选 ${selectedTaskIds.length} 单的签证金额统一设为「${label}」？`)
    )
      return;
    setBatchCostSubmitting(true);
    setBatchResult(null);
    try {
      const res = await api.batchSetVisaTaskCost(token, selectedTaskIds, payload);
      setBatchResult(res);
      if (res.failureCount === 0) {
        setBatchCostUsd('');
        setBatchCostRate('');
        setBatchCostCny('');
      }
      setRefreshNonce((n) => n + 1);
    } catch (e: unknown) {
      alert(e instanceof ApiError ? `批量设金额失败：${e.message}` : '批量设金额失败');
    } finally {
      setBatchCostSubmitting(false);
    }
  };

  // 批量设签证公司：只带 visaSupplier，后端不会动这批任务的金额
  const applyBatchSupplier = async () => {
    if (!token || selectedTaskIds.length === 0 || batchSupplierSubmitting) return;
    if (selectedTaskIds.length > NOTES_BATCH_LIMIT) {
      alert(
        `单次最多批量处理 ${NOTES_BATCH_LIMIT} 单，请分批操作（当前涉及 ${selectedTaskIds.length} 单）`,
      );
      return;
    }
    const next = batchSupplier.trim();
    if (
      !window.confirm(
        `将所选 ${selectedTaskIds.length} 单的签证公司统一设为「${next || '（清空）'}」？金额不受影响。`,
      )
    )
      return;
    setBatchSupplierSubmitting(true);
    setBatchResult(null);
    try {
      const res = await api.batchSetVisaTaskCost(token, selectedTaskIds, { visaSupplier: next });
      setBatchResult(res);
      if (res.failureCount === 0) setBatchSupplier('');
      setRefreshNonce((n) => n + 1);
    } catch (e: unknown) {
      alert(e instanceof ApiError ? `批量设签证公司失败：${e.message}` : '批量设签证公司失败');
    } finally {
      setBatchSupplierSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">签证台</h1>
          <p className="page-sub">
            乘客默认平铺展示，勾选到人后可只送其中几位：一键标记
            <span className="badge-info mx-1">已送签材料准备</span>
            或
            <span className="badge-success mx-1">已送签</span>
            。订单行显示「已送 x/y」进度。
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <div>
            <label className="label">状态筛选</label>
            <select
              className="input max-w-[16rem] py-1.5"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as StatusFilter);
                clearSelection();
              }}
            >
              {FILTER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-muted">新录入的待送签单在『待处理』里</p>
          </div>
          <div>
            <label className="label">签证类型</label>
            <select
              className="input max-w-[10rem] py-1.5"
              value={issuanceFilter}
              onChange={(e) => {
                setIssuanceFilter(e.target.value as IssuanceFilter);
                clearSelection();
              }}
            >
              {ISSUANCE_FILTER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-muted">按签发方式筛选</p>
          </div>
          <div>
            <label className="label">出发日期区间</label>
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                className="input max-w-[10rem] py-1.5"
                value={departureFrom}
                max={departureTo || undefined}
                onChange={(e) => {
                  setDepartureFrom(e.target.value);
                  clearSelection();
                }}
              />
              <span className="text-xs text-ink-muted">至</span>
              <input
                type="date"
                className="input max-w-[10rem] py-1.5"
                value={departureTo}
                min={departureFrom || undefined}
                onChange={(e) => {
                  setDepartureTo(e.target.value);
                  clearSelection();
                }}
              />
              {(departureFrom || departureTo) && (
                <button
                  type="button"
                  className="btn-ghost py-1.5 text-xs"
                  onClick={() => {
                    setDepartureFrom('');
                    setDepartureTo('');
                    clearSelection();
                  }}
                >
                  清除
                </button>
              )}
            </div>
            <p className="mt-1 text-xs text-ink-muted">按客户出发日区间筛选（纯签证单无航班仍保留）</p>
          </div>
          <div>
            <label className="label">备注搜索</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                className="input max-w-[14rem] py-1.5"
                value={notesQueryInput}
                placeholder="按备注内容筛选…"
                onChange={(e) => {
                  setNotesQueryInput(e.target.value);
                  clearSelection();
                }}
              />
              {notesQueryInput && (
                <button
                  type="button"
                  className="btn-ghost py-1.5 text-xs"
                  onClick={() => {
                    setNotesQueryInput('');
                    clearSelection();
                  }}
                >
                  清除
                </button>
              )}
            </div>
            <p className="mt-1 text-xs text-ink-muted">服务端按备注模糊匹配（不受 200 条截断影响）</p>
          </div>
        </div>
      </section>

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <span>{error}</span>
          <button
            type="button"
            className="btn-secondary py-1 text-xs"
            onClick={() => setRefreshNonce((n) => n + 1)}
          >
            重试
          </button>
        </div>
      )}

      {/* ── 批量操作工具条 ───────────────────────────────────── */}
      {selectedPassengerIds.size > 0 && (
        <section className="card border-brand-200 bg-brand-50/60">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold text-ink">
              已选 <span className="text-brand">{selectedPassengerIds.size}</span> 名乘客
              <span className="ml-1 text-ink-muted">（{selectedOrderIds.length} 单）</span>
            </span>
            <span className="text-slate-300">|</span>
            <label className="text-sm text-ink-soft">批量标记为：</label>
            <select
              className="input max-w-[12rem] py-1.5"
              value={batchTarget}
              onChange={(e) => setBatchTarget(e.target.value as VisaSubmissionStatus)}
              disabled={submitting}
            >
              {BATCH_TARGETS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <button className="btn-primary py-1.5" onClick={() => void applyBatch()} disabled={submitting}>
              {submitting ? '处理中…' : '执行'}
            </button>
            <button className="btn-ghost py-1.5" onClick={clearSelection} disabled={submitting}>
              清除选择
            </button>
            <span className="text-slate-300">|</span>
            <button
              type="button"
              className="btn-secondary py-1.5"
              onClick={() => void handleDownloadVisaRoster()}
              disabled={selectedOrderIds.length === 0 || rosterDownloading}
              title="下载勾选乘客所属订单的合并签证名单表（同单去重）"
            >
              {rosterDownloading
                ? '打包中…'
                : `下载名单表${selectedOrderIds.length > 0 ? `（${selectedOrderIds.length}单）` : ''}`}
            </button>
            <button
              type="button"
              className="btn-secondary py-1.5"
              onClick={() => void handleDownloadVisaPassports()}
              disabled={selectedOrderIds.length === 0 || passportsDownloading}
              title="下载勾选乘客所属订单的护照图打包（同单去重）"
            >
              {passportsDownloading
                ? '打包中…'
                : `下载护照包${selectedOrderIds.length > 0 ? `（${selectedOrderIds.length}单）` : ''}`}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-brand-200/60 pt-3">
            <label className="text-sm text-ink-soft">批量备注：</label>
            <input
              type="text"
              className="input max-w-xs py-1.5 text-sm"
              value={batchNote}
              placeholder="填写后覆盖所选订单备注…"
              disabled={batchNoteSubmitting || submitting}
              onChange={(e) => setBatchNote(e.target.value)}
            />
            <button
              type="button"
              className="btn-secondary py-1.5"
              onClick={() => void applyBatchNote()}
              disabled={batchNoteSubmitting || submitting || selectedTaskIds.length === 0}
              title={`将覆盖所选 ${selectedTaskIds.length} 单的现有备注（上限 ${NOTES_BATCH_LIMIT} 单）`}
            >
              {batchNoteSubmitting ? '保存中…' : '应用备注'}
            </button>
            <span className="text-[11px] text-ink-muted">
              备注按订单级作用于所选乘客所属的 {selectedTaskIds.length} 单（上限 {NOTES_BATCH_LIMIT} 单）
            </span>
          </div>
          {/* 批量设签证公司（与金额独立：只改公司不动金额）*/}
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-brand-200/60 pt-3">
            <label className="text-sm text-ink-soft">批量签证公司：</label>
            <input
              type="text"
              className="input max-w-xs py-1.5 text-sm"
              value={batchSupplier}
              placeholder="如 XX签证服务"
              disabled={batchSupplierSubmitting || submitting}
              onChange={(e) => setBatchSupplier(e.target.value)}
            />
            <button
              type="button"
              className="btn-secondary py-1.5"
              onClick={() => void applyBatchSupplier()}
              disabled={batchSupplierSubmitting || submitting || selectedTaskIds.length === 0}
              title={`将所选 ${selectedTaskIds.length} 单的签证公司统一覆盖（上限 ${NOTES_BATCH_LIMIT} 单）`}
            >
              {batchSupplierSubmitting ? '设置中…' : '应用签证公司'}
            </button>
            <span className="text-[11px] text-ink-muted">
              只改签证公司，不影响已设的金额；留空 = 清空
            </span>
          </div>
          {/* 批量设签证金额（签证公司按航班统一单价是常态）*/}
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-brand-200/60 pt-3">
            <label className="text-sm text-ink-soft">批量设金额：</label>
            <span className="text-xs text-ink-muted">$</span>
            <input
              type="text"
              inputMode="decimal"
              className="input w-20 py-1.5 text-sm"
              value={batchCostUsd}
              placeholder="美金"
              disabled={batchCostSubmitting || submitting}
              onChange={(e) => setBatchCostUsd(e.target.value)}
            />
            <span className="text-xs text-ink-muted">×</span>
            <input
              type="text"
              inputMode="decimal"
              className="input w-20 py-1.5 text-sm"
              value={batchCostRate}
              placeholder="汇率"
              disabled={batchCostSubmitting || submitting}
              onChange={(e) => setBatchCostRate(e.target.value)}
            />
            {batchCostAutoCny != null && (
              <span className="text-xs text-emerald-700">= ¥{batchCostAutoCny}/人</span>
            )}
            <span className="text-xs text-ink-muted">或 直填 ¥</span>
            <input
              type="text"
              inputMode="decimal"
              className="input w-24 py-1.5 text-sm disabled:bg-slate-50"
              value={batchCostCny}
              placeholder="人民币"
              disabled={
                batchCostSubmitting ||
                submitting ||
                batchCostUsdNum != null ||
                batchCostRateNum != null
              }
              onChange={(e) => setBatchCostCny(e.target.value)}
            />
            <button
              type="button"
              className="btn-secondary py-1.5"
              onClick={() => void applyBatchCost()}
              disabled={batchCostSubmitting || submitting || selectedTaskIds.length === 0}
              title={`将所选 ${selectedTaskIds.length} 单签证任务统一设成同一人均单价（上限 ${NOTES_BATCH_LIMIT} 单）`}
            >
              {batchCostSubmitting ? '设置中…' : '应用金额'}
            </button>
            <span className="text-[11px] text-ink-muted">
              作用于所选 {selectedTaskIds.length} 单签证任务；三格留空 = 清空回退产品成本
              {todayFxRate != null && `；汇率已按当日汇率表带出（${todayFxRate}），可手改`}
            </span>
          </div>
          {downloadError && <p className="mt-2 text-xs text-rose-600">{downloadError}</p>}
          {batchResult && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
              <div className="text-ink-soft">
                成功 {batchResult.successCount} 条
                {batchResult.failureCount > 0 && (
                  <span className="ml-3 text-rose-600">失败 {batchResult.failureCount} 条</span>
                )}
              </div>
              {batchResult.failures.length > 0 && (
                <ul className="mt-1 max-h-32 overflow-auto text-rose-600">
                  {batchResult.failures.map((f) => (
                    <li key={f.id} className="font-mono text-[11px]">
                      · {f.id.slice(0, 8)}…：{f.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {!loading && totalCount != null && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <span>
            共 <span className="font-semibold text-ink">{totalCount}</span> 条签证任务
          </span>
          {totalCount > tasks.length && (
            <span className="badge-warning">仅显示前 {tasks.length} 条，请用筛选缩小范围</span>
          )}
        </div>
      )}

      {/* ── 任务列表 ─────────────────────────────────────────── */}
      <section className="card p-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-2 text-sm text-ink-soft">
          <div className="flex items-center gap-2">
            <span>每页</span>
            <select
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm"
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              aria-label="每页条数"
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>{n} 条</option>
              ))}
            </select>
            <span className="text-xs text-ink-muted">表头「全选」只选当前页，翻页后可继续勾选累加</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="nums text-xs text-ink-muted">
              {tasks.length === 0
                ? '共 0 条'
                : `第 ${pageStart + 1}-${Math.min(pageStart + pageSize, tasks.length)} 条 / 共 ${tasks.length} 条`}
            </span>
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-sm disabled:opacity-40"
              onClick={() => setCurrentPage(Math.max(1, effectiveCurrentPage - 1))}
              disabled={effectiveCurrentPage <= 1}
            >
              上一页
            </button>
            <span className="nums text-xs">{effectiveCurrentPage} / {totalPages}</span>
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-sm disabled:opacity-40"
              onClick={() => setCurrentPage(Math.min(totalPages, effectiveCurrentPage + 1))}
              disabled={effectiveCurrentPage >= totalPages}
            >
              下一页
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="table-admin">
            <thead>
              <tr>
                <th className="w-10 text-center">
                  <input
                    type="checkbox"
                    aria-label="全选当前页全部乘客"
                    checked={allVisibleSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someVisibleSelected;
                    }}
                    onChange={toggleAllVisible}
                  />
                </th>
                <th className="w-12 text-center">序号</th>
                <th>订单号</th>
                <th className="text-right">送签进度</th>
                <th>备注</th>
                <th className="text-center">订单状态</th>
                <th className="text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-ink-muted">
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                      加载签证任务…
                    </span>
                  </td>
                </tr>
              ) : tasks.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-ink-muted">
                    该筛选条件下暂无签证任务
                  </td>
                </tr>
              ) : (
                tasks.map((task, index) => (
                  <OrderGroup
                    key={task.id}
                    task={task}
                    rowNumber={index + 1}
                    hidden={index < pageStart || index >= pageStart + pageSize}
                    selectedPassengerIds={selectedPassengerIds}
                    onTogglePassenger={togglePassenger}
                    onToggleOrderPassengers={toggleOrderPassengers}
                    token={token}
                    defaultFxRate={todayFxRate}
                    onChanged={() => setRefreshNonce((n) => n + 1)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
