/**
 * 签证台 · ADMIN/STAFF — 签证履约任务批量状态流转（批量标"已送签"）
 *
 * 数据源：backend/src/modules/fulfillment/*
 *   GET  /fulfillment-tasks?type=VISA_APPLICATION&status=   任务列表（含 passengers[]）
 *   POST /fulfillment-tasks/batch-status                    批量改状态（部分失败返回 failures）
 *   GET  /orders/:id/passport-photos.zip                   下载护照包（送签用）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type FulfillmentStatus,
  type FulfillmentTask,
  type VisaTaskPassenger,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { localYmd } from '../lib/airports';

// 签证语境的状态文案（IN_PROGRESS/CONFIRMED 与批量操作下拉一致）
const VISA_STATUS_LABEL: Record<FulfillmentStatus, string> = {
  PENDING: '待处理',
  IN_PROGRESS: '已送签材料准备',
  CONFIRMED: '已送签',
  CANCELLED: '已取消',
  FAILED: '失败',
};

// 状态徽章映射到 Console badge-* 体系（克制配色，仅状态用色）
const VISA_STATUS_BADGE: Record<FulfillmentStatus, string> = {
  PENDING: 'badge-neutral',
  IN_PROGRESS: 'badge-info',
  CONFIRMED: 'badge-success',
  CANCELLED: 'badge-neutral',
  FAILED: 'badge-danger',
};

// 批量流转的目标状态（签证台只做"材料准备 / 已送签"两档）
const BATCH_TARGETS: Array<{ value: FulfillmentStatus; label: string }> = [
  { value: 'IN_PROGRESS', label: '已送签材料准备' },
  { value: 'CONFIRMED', label: '已送签' },
];

// 后端 batch-status 单次最多 100 条
const BATCH_LIMIT = 100;

// 状态筛选：OPEN = 待处理 + 材料准备（默认）；ALL = 全部
type StatusFilter = 'OPEN' | 'ALL' | FulfillmentStatus;

const FILTER_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'OPEN', label: '待处理 + 材料准备（默认）' },
  { value: 'CONFIRMED', label: '已处理（已送签）' },
  { value: 'PENDING', label: '仅待处理' },
  { value: 'IN_PROGRESS', label: '仅已送签材料准备' },
  { value: 'CANCELLED', label: '仅已取消' },
  { value: 'FAILED', label: '仅失败' },
  { value: 'ALL', label: '全部状态' },
];

// ── 乘客行：名称 / 护照号 / 照片缩略图 ─────────────────────────────────────
interface PassengerRowProps {
  passenger: VisaTaskPassenger;
  /** 展开后按需拉取到的护照大图（覆盖列表里的 null）；未取到则回落到 passenger 上的值 */
  photoUrl?: string | null;
  /** 护照图仍在按需加载中 */
  photosLoading?: boolean;
  /** 点开「护照」时若本单尚未拉图，触发按需拉取（幂等：已加载/加载中则无操作） */
  onRequestPhotos?: () => void;
}
function PassengerRow({ passenger, photoUrl, photosLoading, onRequestPhotos }: PassengerRowProps) {
  const [enlarged, setEnlarged] = useState(false);
  // 优先用按需加载到的真图；否则回落到列表下发的值（现列表恒为 null）
  const resolvedPhoto = photoUrl ?? passenger.passportPhotoUrl;

  // 打开护照大图：若还没图，先触发本单按需拉取（modal 内展示 loading 态）
  const openPassport = () => {
    if (!resolvedPhoto) onRequestPhotos?.();
    setEnlarged(true);
  };

  // 姓名按护照惯例展示为 姓/名（LAST/FIRST）；缺拆分字段时回退整名
  const displayName =
    passenger.lastName && passenger.firstName
      ? `${passenger.lastName}/${passenger.firstName}`.toUpperCase()
      : passenger.fullName || '—';
  // 性别徽标：M→男 / F→女 / X→其他；无值显示 —
  const genderLabel =
    passenger.gender === 'M'
      ? '男'
      : passenger.gender === 'F'
        ? '女'
        : passenger.gender === 'X'
          ? '其他'
          : null;

  return (
    <div className="flex items-center gap-3 py-1 text-xs">
      {/* 护照照片区 */}
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
            <img
              src={resolvedPhoto}
              alt={`${passenger.fullName} 护照`}
              className="h-full w-full object-cover"
            />
          </button>
        ) : passenger.hasPhoto ? (
          // 有照片但本次未取到（加载失败）—— 与"缺照"区分，中性占位
          <div className="flex h-8 w-8 items-center justify-center rounded border border-slate-200 bg-slate-50 text-[9px] text-ink-muted">
            —
          </div>
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded border border-rose-200 bg-rose-50 text-[9px] font-semibold text-rose-600">
            缺
          </div>
        )}
      </div>

      {/* 姓名 / 护照号 / 签证日期（若 payload 带了就显示，没带也不报错） */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-ink truncate">{displayName}</span>
          {passenger.chineseName && (
            <span className="text-ink-muted truncate">{passenger.chineseName}</span>
          )}
          <span className="badge-neutral shrink-0 text-[10px]">{genderLabel ?? '—'}</span>
        </div>
        <div className="font-mono text-ink-muted truncate">{passenger.documentNumber || '—'}</div>
        {(() => {
          // 签证日期目前未必在签证任务 payload 里 → 防御式读取，存在才显示。
          const v = passenger as {
            visaIssueDate?: string | null;
            visaEffectiveDate?: string | null;
            visaExpiry?: string | null;
          };
          const parts = [
            v.visaIssueDate ? `出签日 ${v.visaIssueDate}` : null,
            v.visaEffectiveDate ? `生效日 ${v.visaEffectiveDate}` : null,
            v.visaExpiry ? `有效期 ${v.visaExpiry}` : null,
          ].filter(Boolean);
          return parts.length > 0 ? (
            <div className="text-[10px] text-ink-muted truncate" title={parts.join(' · ')}>
              {parts.join(' · ')}
            </div>
          ) : null;
        })()}
      </div>

      {/* 右侧标识：有图→可点「护照」（点开大图核对姓名）；无图→红「缺护照」 */}
      {passenger.hasPhoto ? (
        <button
          type="button"
          onClick={openPassport}
          title="点击查看护照大图核对信息"
          className="badge-info shrink-0 cursor-pointer text-[10px] hover:opacity-80 transition-opacity"
        >
          护照
        </button>
      ) : (
        <span className="badge-danger shrink-0 text-[10px]">缺护照</span>
      )}

      {/* 护照大图查看 —— 标题带乘客姓名，便于核对；图未取到时按需加载/兜底提示 */}
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

// ── 可展开的任务行 ────────────────────────────────────────────────────────────
interface TaskRowProps {
  task: FulfillmentTask;
  selected: boolean;
  onToggle: () => void;
  token: string;
  /** 备注保存成功后触发列表刷新 */
  onChanged: () => void;
}
function TaskRow({ task, selected, onToggle, token, onChanged }: TaskRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // 护照大图按需加载：列表已瘦身不带图，展开某单时才拉真图（避免整页数百 MB base64）
  const [photoMap, setPhotoMap] = useState<Record<string, string | null>>({});
  const [photosLoading, setPhotosLoading] = useState(false);
  const [photosError, setPhotosError] = useState<string | null>(null);
  const photosLoadedRef = useRef(false);

  // 备注 = 任务级 task.notes（可编辑），区别于订单级 order.notes（只读）
  const [noteDraft, setNoteDraft] = useState(task.notes ?? '');
  const [savingNote, setSavingNote] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  // 输入框是否聚焦中：刷新时若用户正在输入，别用服务端值覆盖草稿（否则丢键入）
  const noteFocusedRef = useRef(false);
  // task 刷新后同步草稿（仅在未聚焦时；避免乐观值与服务端不一致，又不打断输入）
  useEffect(() => {
    if (!noteFocusedRef.current) setNoteDraft(task.notes ?? '');
  }, [task.notes]);

  const passengers = task.passengers ?? [];
  const missingCount = passengers.filter((p) => !p.hasPhoto).length;
  const orderId = task.item.orderId;

  // 按需拉取本单乘客护照真图（首次展开时；失败允许重试）
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
        photosLoadedRef.current = false; // 允许重试
        setPhotosError(e instanceof ApiError ? e.message : '护照图加载失败');
      })
      .finally(() => setPhotosLoading(false));
  }, [orderId, passengers.length, token]);

  // 点开「护照」时的按需拉取：仅在未加载且非加载中时触发（幂等，避免重复请求）
  const ensurePhotos = useCallback(() => {
    if (!photosLoadedRef.current && !photosLoading) loadPhotos();
  }, [loadPhotos, photosLoading]);

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !photosLoadedRef.current) loadPhotos();
  };

  // 出发日期（本地化）：纯签证单无航班 → null
  const departureYmd =
    task.order?.departureTime && task.order?.departureTz
      ? localYmd(task.order.departureTime, task.order.departureTz)
      : null;

  // 单次/多次签徽章：从签证产品名启发式判断
  const visaName = task.visaName ?? '';
  const visaEntryBadge = /多次/.test(visaName)
    ? '多次签'
    : /单次/.test(visaName)
      ? '单次签'
      : null;

  const saveNote = async () => {
    if (savingNote) return; // 防重入：Enter→blur 可能重复触发
    const next = noteDraft.trim();
    if (next === (task.notes ?? '')) return; // 无变化不提交
    setSavingNote(true);
    setNoteError(null);
    try {
      await api.updateFulfillmentTask(token, task.id, { notes: next });
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

  return (
    <>
      <tr className={selected ? 'bg-brand-50/70' : ''}>
        <td className="align-top text-center">
          <input
            type="checkbox"
            aria-label={`选择订单 ${task.order?.orderNumber ?? task.id}`}
            checked={selected}
            onChange={onToggle}
          />
        </td>
        <td className="align-top font-mono text-xs text-ink">
          <div>{task.order?.orderNumber ?? '—'}</div>
          {/* 出发日期（不是录入日期）；纯签证单无航班 → — */}
          <div className="mt-0.5 font-sans text-[10px] text-ink-muted">
            出发 {departureYmd ?? '—'}
          </div>
        </td>
        <td className="align-top text-right nums">{task.item.quantity}</td>
        <td className="align-top text-xs text-ink-muted">
          <input
            className="input max-w-xs py-1 text-xs"
            value={noteDraft}
            placeholder="添加备注…"
            disabled={savingNote}
            onChange={(e) => setNoteDraft(e.target.value)}
            onFocus={() => { noteFocusedRef.current = true; }}
            onBlur={() => { noteFocusedRef.current = false; void saveNote(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          {savingNote && <div className="mt-0.5 text-[10px] text-ink-muted">保存中…</div>}
          {noteError && <div className="mt-0.5 text-[10px] text-rose-600">{noteError}</div>}
        </td>
        <td className="align-top text-center">
          <span className={VISA_STATUS_BADGE[task.status]}>
            {VISA_STATUS_LABEL[task.status]}
          </span>
          {visaEntryBadge && (
            <div className="mt-1">
              <span className="badge-neutral text-[10px]">{visaEntryBadge}</span>
            </div>
          )}
        </td>
        <td className="align-top text-center">
          <button
            type="button"
            onClick={toggleExpanded}
            className="btn-ghost py-0.5 px-2 text-xs"
            title={expanded ? '收起乘客信息' : '查看乘客 / 护照'}
          >
            {expanded ? '收起' : `乘客${passengers.length > 0 ? `(${passengers.length})` : ''}`}
            {missingCount > 0 && (
              <span className="badge-danger ml-1 text-[10px]">缺 {missingCount}</span>
            )}
          </button>
        </td>
      </tr>

      {expanded && (
        <tr className="bg-slate-50">
          <td colSpan={6} className="px-4 pb-3 pt-2">
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
                <div className="max-w-lg divide-y divide-slate-100">
                  {passengers.map((p) => (
                    <PassengerRow
                      key={p.id}
                      passenger={p}
                      photoUrl={photoMap[p.id]}
                      photosLoading={photosLoading}
                      onRequestPhotos={ensurePhotos}
                    />
                  ))}
                </div>
              </>
            )}

            {passengers.length > 0 && (
              <div className="mt-2 flex items-center gap-3">
                <button
                  type="button"
                  className="btn-secondary text-xs py-1.5"
                  onClick={() => void handleDownloadZip()}
                  disabled={downloading}
                >
                  {downloading ? '打包中…' : '下载护照'}
                </button>
                {missingCount > 0 && (
                  <span className="text-xs text-rose-600">
                    注意：{missingCount} 名乘客缺少护照照片
                  </span>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── 主页面 ────────────────────────────────────────────────────────────────────
export function VisaDeskPage() {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';

  const [tasks, setTasks] = useState<FulfillmentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('OPEN');
  // 出发日期筛选（单日 YYYY-MM-DD）；空 = 不按出发日过滤
  const [departureDate, setDepartureDate] = useState('');
  // 「打包下载勾选订单签证资料」入口状态（合并签证名单 xlsx + 全部护照图）
  const [bundleDownloading, setBundleDownloading] = useState(false);
  const [bundleError, setBundleError] = useState<string | null>(null);

  // ── 批量选择 / 流转状态 ─────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchTarget, setBatchTarget] = useState<FulfillmentStatus>('CONFIRMED');
  const [submitting, setSubmitting] = useState(false);
  const [batchResult, setBatchResult] = useState<{
    successCount: number;
    failureCount: number;
    failures: Array<{ id: string; error: string }>;
  } | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  // 拉签证任务 — 单状态筛选直接走后端；OPEN/ALL 拉全量后前端过滤
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const backendStatus =
      statusFilter === 'OPEN' || statusFilter === 'ALL' ? undefined : statusFilter;
    api
      .listFulfillmentTasks(token, {
        type: 'VISA_APPLICATION',
        status: backendStatus,
        pageSize: 200,
      })
      .then((res) => {
        if (cancelled) return;
        setTasks(res.tasks);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : '签证任务加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [token, statusFilter, refreshNonce]);

  const filtered = useMemo(() => {
    let list = tasks;
    if (statusFilter === 'OPEN') {
      list = list.filter((t) => t.status === 'PENDING' || t.status === 'IN_PROGRESS');
    }
    // 出发日期过滤（客户端）：选了日期时按本地出发日比对；纯签证单无航班 → 保留可见（不被日期筛选误隐藏）
    if (departureDate) {
      list = list.filter((t) => {
        if (!t.order?.departureTime || !t.order?.departureTz) return true;
        return localYmd(t.order.departureTime, t.order.departureTz) === departureDate;
      });
    }
    return list;
  }, [tasks, statusFilter, departureDate]);

  // ── 勾选 helpers（镜像 OrdersPage 批量管理）────────────────
  const visibleIds = useMemo(() => filtered.map((t) => t.id), [filtered]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = !allVisibleSelected && visibleIds.some((id) => selectedIds.has(id));

  const toggleRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  };
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setBatchResult(null);
  }, []);

  // 勾选的任务 id → 去重后的订单 id 列表（一单可能有多条签证任务/多位乘客，去重成订单）
  const selectedOrderIds = useMemo(
    () =>
      Array.from(
        new Set(
          tasks
            .filter((t) => selectedIds.has(t.id))
            .map((t) => t.item.orderId)
            .filter((id): id is string => Boolean(id)),
        ),
      ),
    [tasks, selectedIds],
  );

  // 打包下载勾选订单的签证资料（一张合并名单 + 全部护照图）
  const handleDownloadVisaBundle = async () => {
    if (!token || selectedOrderIds.length === 0 || bundleDownloading) return;
    setBundleDownloading(true);
    setBundleError(null);
    try {
      const blob = await api.downloadVisaBundle(token, selectedOrderIds);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `签证资料_${selectedOrderIds.length}单.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setBundleError(e instanceof ApiError ? e.message : '打包下载失败，请重试');
    } finally {
      setBundleDownloading(false);
    }
  };

  const applyBatch = async () => {
    if (!token || selectedIds.size === 0) return;
    if (selectedIds.size > BATCH_LIMIT) {
      alert(`单次最多批量处理 ${BATCH_LIMIT} 条，请分批操作（当前已选 ${selectedIds.size} 条）`);
      return;
    }
    const targetLabel = VISA_STATUS_LABEL[batchTarget];
    if (!window.confirm(`将 ${selectedIds.size} 条签证任务标记为「${targetLabel}」？`)) return;
    setSubmitting(true);
    setBatchResult(null);
    try {
      const res = await api.batchUpdateFulfillmentStatus(token, Array.from(selectedIds), batchTarget);
      setBatchResult(res);
      if (res.failureCount === 0) setSelectedIds(new Set());
      setRefreshNonce((n) => n + 1);
    } catch (e: unknown) {
      alert(e instanceof ApiError ? `批量操作失败：${e.message}` : '批量操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">签证台</h1>
          <p className="page-sub">
            签证履约任务批量流转：勾选订单后一键标记
            <span className="badge-info mx-1">已送签材料准备</span>
            或
            <span className="badge-success mx-1">已送签</span>
            。点击"乘客"可展开护照信息及下载按钮。
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
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-muted">新录入的待送签单在『待处理』里</p>
          </div>
          <div>
            <label className="label">出发日期</label>
            <div className="flex items-center gap-2">
              <input
                type="date"
                className="input max-w-[12rem] py-1.5"
                value={departureDate}
                onChange={(e) => {
                  setDepartureDate(e.target.value);
                  clearSelection();
                }}
              />
              {departureDate && (
                <button
                  type="button"
                  className="btn-ghost py-1.5 text-xs"
                  onClick={() => {
                    setDepartureDate('');
                    clearSelection();
                  }}
                >
                  清除
                </button>
              )}
            </div>
            <p className="mt-1 text-xs text-ink-muted">按客户出发日筛选（纯签证单无航班）</p>
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
      {selectedIds.size > 0 && (
        <section className="card border-brand-200 bg-brand-50/60">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold text-ink">
              已选 <span className="text-brand">{selectedIds.size}</span> 条签证任务
            </span>
            <span className="text-slate-300">|</span>
            <label className="text-sm text-ink-soft">批量标记为：</label>
            <select
              className="input max-w-[12rem] py-1.5"
              value={batchTarget}
              onChange={(e) => setBatchTarget(e.target.value as FulfillmentStatus)}
              disabled={submitting}
            >
              {BATCH_TARGETS.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <button
              className="btn-primary py-1.5"
              onClick={() => void applyBatch()}
              disabled={submitting}
            >
              {submitting ? '处理中…' : '执行'}
            </button>
            <button
              className="btn-ghost py-1.5"
              onClick={clearSelection}
              disabled={submitting}
            >
              清除选择
            </button>
            <span className="text-slate-300">|</span>
            {/* 打包下载勾选订单的签证资料（合并名单 xlsx + 全部护照图） */}
            <button
              type="button"
              className="btn-secondary py-1.5"
              onClick={() => void handleDownloadVisaBundle()}
              disabled={selectedOrderIds.length === 0 || bundleDownloading}
              title="打包勾选订单的签证名单与护照图（多条任务/乘客同单会自动去重）"
            >
              {bundleDownloading
                ? '打包中…'
                : `打包下载勾选订单签证资料${
                    selectedOrderIds.length > 0 ? `（${selectedOrderIds.length}单）` : ''
                  }`}
            </button>
          </div>
          {bundleError && <p className="mt-2 text-xs text-rose-600">{bundleError}</p>}
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
                    <li key={f.id} className="font-mono text-[11px]">· {f.id.slice(0, 8)}…：{f.error}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {/* ── 任务列表 ─────────────────────────────────────────── */}
      <section className="card p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-admin">
            <thead>
              <tr>
                <th className="w-10 text-center">
                  <input
                    type="checkbox"
                    aria-label="全选当前列表"
                    checked={allVisibleSelected}
                    ref={(el) => { if (el) el.indeterminate = someVisibleSelected; }}
                    onChange={toggleAllVisible}
                  />
                </th>
                <th>订单号</th>
                <th className="text-right">乘客数</th>
                <th>备注</th>
                <th className="text-center">当前状态</th>
                <th className="text-center">护照信息</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-ink-muted">
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                      加载签证任务…
                    </span>
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-ink-muted">
                    该筛选条件下暂无签证任务
                  </td>
                </tr>
              ) : (
                filtered.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    selected={selectedIds.has(task.id)}
                    onToggle={() => toggleRow(task.id)}
                    token={token}
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
