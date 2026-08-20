import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type MarketingPosterDetail, type MarketingPosterListItem, type MarketingPosterStatus, type MarketingTemplate, type RangeSchedule } from '../lib/api';
import { PosterDetailModal } from '../components/PosterDetailModal';
import { useAuth } from '../stores/auth';

const PAGE_SIZE = 20;
const STATUS_LABEL: Record<MarketingPosterStatus, string> = {
  READY: '生成完成',
  NEEDS_REVIEW: '待人工核对',
  FAILED: '生成失败',
  GENERATING: '生成中',
};

const STATUS_BADGE: Record<MarketingPosterStatus, string> = {
  READY: 'badge-success',
  NEEDS_REVIEW: 'badge-warning',
  FAILED: 'badge-danger',
  GENERATING: 'badge-neutral',
};

type StatusFilter = '' | MarketingPosterStatus;

function todayYmd(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateAfter(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatSchedule(schedule: RangeSchedule): string {
  const date = new Date(schedule.departureTime);
  let dateText: string;
  try {
    dateText = new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: schedule.departureTz,
    }).format(date);
  } catch {
    dateText = formatDateTime(schedule.departureTime).slice(5, 16);
  }
  return `${schedule.flightNumber} ${schedule.originCode}-${schedule.destinationCode} ${dateText}`;
}

function posterSummary(detail: MarketingPosterDetail): MarketingPosterListItem {
  return {
    id: detail.id,
    kind: detail.kind,
    status: detail.status,
    title: detail.title,
    flightId: detail.flightId,
    templateKey: detail.templateKey,
    attempts: detail.attempts,
    createdAt: detail.createdAt,
    createdBy: detail.createdBy,
  };
}

export function MarketingPage() {
  const token = useAuth((s) => s.tokens?.accessToken ?? '');
  const [formOpen, setFormOpen] = useState(true);
  const [title, setTitle] = useState('');
  const [from, setFrom] = useState(todayYmd());
  const [to, setTo] = useState(dateAfter(60));
  const [schedules, setSchedules] = useState<RangeSchedule[]>([]);
  const [outboundScheduleId, setOutboundScheduleId] = useState('');
  const [returnScheduleId, setReturnScheduleId] = useState('');
  const [templates, setTemplates] = useState<MarketingTemplate[]>([]);
  const [templateKey, setTemplateKey] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [baggageText, setBaggageText] = useState('');
  const [extraNote, setExtraNote] = useState('');
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<{ message: string; aiNotConfigured: boolean } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
  const [page, setPage] = useState(1);
  const [posters, setPosters] = useState<MarketingPosterListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [listNonce, setListNonce] = useState(0);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<MarketingPosterDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const detailRequestIdRef = useRef(0);
  const detailTriggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; detailRequestIdRef.current += 1; };
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api.marketing.listTemplates(token)
      .then((res) => {
        if (!cancelled) setTemplates(res.templates);
      })
      .catch((error: unknown) => {
        if (!cancelled) setTemplateError(error instanceof ApiError ? error.message : '版式加载失败');
      });
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    if (!token || !from || !to || from > to) {
      setSchedules([]);
      setScheduleLoading(false);
      return;
    }
    let cancelled = false;
    setScheduleLoading(true);
    setScheduleError(null);
    api.listSchedulesInRange(token, { from, to })
      .then((res) => {
        if (!cancelled) setSchedules(res.schedules);
      })
      .catch((error: unknown) => {
        if (!cancelled) setScheduleError(error instanceof ApiError ? error.message : '班次加载失败');
      })
      .finally(() => {
        if (!cancelled) setScheduleLoading(false);
      });
    return () => { cancelled = true; };
  }, [token, from, to]);

  useEffect(() => {
    if (!returnScheduleId) return;
    const outbound = schedules.find((schedule) => schedule.id === outboundScheduleId);
    const inbound = schedules.find((schedule) => schedule.id === returnScheduleId);
    const valid = Boolean(
      outbound && inbound &&
      inbound.id !== outbound.id &&
      inbound.originCode === outbound.destinationCode &&
      inbound.destinationCode === outbound.originCode &&
      new Date(inbound.departureTime).getTime() > new Date(outbound.departureTime).getTime(),
    );
    if (!valid) setReturnScheduleId('');
  }, [outboundScheduleId, returnScheduleId, schedules]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    api.marketing.listPosters(token, {
      status: statusFilter || undefined,
      page,
      pageSize: PAGE_SIZE,
    })
      .then((res) => {
        if (cancelled) return;
        setPosters(res.items);
        setTotal(res.total);
      })
      .catch((error: unknown) => {
        if (!cancelled) setListError(error instanceof ApiError ? error.message : '海报列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setListLoading(false);
      });
    return () => { cancelled = true; };
  }, [token, statusFilter, page, listNonce]);

  useEffect(() => {
    if (!generating) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [generating]);

  async function submitForm(): Promise<void> {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || !outboundScheduleId || !templateKey) {
      setSubmitError({ message: '请填写海报名称、去程班次和版式', aiNotConfigured: false });
      return;
    }
    if (!token || generating) return;
    detailTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setGenerating(true);
    setElapsedSeconds(0);
    setSubmitError(null);
    const body = {
      title: trimmedTitle,
      outboundScheduleId,
      templateKey,
      ...(returnScheduleId ? { returnScheduleId } : {}),
      ...(effectiveFrom.trim() ? { effectiveFrom: effectiveFrom.trim() } : {}),
      ...(baggageText.trim() ? { baggageText: baggageText.trim() } : {}),
      ...(extraNote.trim() ? { extraNote: extraNote.trim() } : {}),
    };
    try {
      const result = await api.marketing.createFlightRoute(token, body);
      if (!mountedRef.current) return;
      const summary = posterSummary(result);
      setPage(1);
      if (!statusFilter || statusFilter === result.status) {
        setPosters((current) => [summary, ...current].slice(0, PAGE_SIZE));
      }
      setTotal((current) => current + 1);
      setListNonce((current) => current + 1);
      detailRequestIdRef.current += 1;
      setDetail(result);
      setDetailError(null);
      setDetailOpen(true);
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      setSubmitError({
        message: error instanceof ApiError ? error.message : '海报生成失败',
        aiNotConfigured: error instanceof ApiError && error.code === 'AI_NOT_CONFIGURED',
      });
    } finally {
      if (mountedRef.current) setGenerating(false);
    }
  }

  async function openDetail(id: string): Promise<void> {
    if (!token) return;
    const requestId = ++detailRequestIdRef.current;
    setDetailOpen(true);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const result = await api.marketing.getPoster(token, id);
      if (!mountedRef.current || detailRequestIdRef.current !== requestId) return;
      setDetail(result);
    } catch (error: unknown) {
      if (!mountedRef.current || detailRequestIdRef.current !== requestId) return;
      setDetailError(error instanceof ApiError ? error.message : '海报详情加载失败');
    } finally {
      if (mountedRef.current && detailRequestIdRef.current === requestId) {
        setDetailLoading(false);
      }
    }
  }

  function closeDetail(): void {
    detailRequestIdRef.current += 1;
    setDetailOpen(false); setDetail(null); setDetailError(null); setDetailLoading(false);
  }

  async function deletePoster(poster: MarketingPosterListItem): Promise<void> {
    if (!token || !window.confirm(`确认删除海报「${poster.title}」？`)) return;
    setDeleteId(poster.id);
    try {
      await api.marketing.deletePoster(token, poster.id);
      if (!mountedRef.current) return;
      const pageWillBecomeEmpty = posters.length === 1 && page > 1;
      setPosters((current) => current.filter((item) => item.id !== poster.id));
      setTotal((current) => Math.max(0, current - 1));
      if (detail?.id === poster.id) closeDetail();
      if (pageWillBecomeEmpty) {
        setPage((current) => current - 1);
      } else {
        setListNonce((current) => current + 1);
      }
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      alert(error instanceof ApiError ? `删除失败：${error.message}` : '删除失败');
    } finally {
      if (mountedRef.current) setDeleteId(null);
    }
  }

  const selectedTemplate = templates.find((item) => item.key === templateKey);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeInvalid = Boolean(from && to && from > to);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="page-title">营销中心</h1>
        <p className="page-sub">选择航线班次和版式，生成可供运营发布的 AI 竖版海报</p>
      </header>

      <section className="card">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink">新建海报</h2>
            <p className="mt-0.5 text-xs text-ink-muted">海报内容和渲染信息以后端返回为准</p>
          </div>
          <button type="button" className="btn-secondary px-3 py-1.5 text-xs" onClick={() => setFormOpen((open) => !open)}>
            {formOpen ? '收起' : '展开'}
          </button>
        </div>

        {formOpen && (
          <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void submitForm(); }}>
            {generating && (
              <div className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
                <div className="font-medium">AI 出背景图 + 服务端合成中，最长约 3 分钟，请勿关闭页面</div>
                <div className="mt-1 text-xs text-brand-700">已耗时 {elapsedSeconds} 秒</div>
              </div>
            )}
            {submitError && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                <div>{submitError.message}</div>
                {submitError.aiNotConfigured && (
                  <div className="mt-1">请先到「<Link className="underline" to="/settings/ai-ocr">AI 识别设置</Link>」页配置密钥</div>
                )}
              </div>
            )}
            {templateError && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{templateError}</div>}
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="label" htmlFor="poster-title">海报名称</label>
                <input id="poster-title" className="input" value={title} maxLength={60} required onChange={(event) => setTitle(event.target.value)} placeholder="例：暑期东京往返特价" />
              </div>
              <div>
                <label className="label" htmlFor="poster-template">版式</label>
                <select id="poster-template" className="input" value={templateKey} required onChange={(event) => setTemplateKey(event.target.value)}>
                  <option value="">请选择版式</option>
                  {templates.map((template) => <option key={template.key} value={template.key}>{template.label}</option>)}
                </select>
                {selectedTemplate?.hint && <p className="mt-1 text-xs text-ink-muted">{selectedTemplate.hint}</p>}
              </div>
              <div className="md:col-span-2">
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="label" htmlFor="schedule-from">班次日期范围</label>
                    <div className="flex items-center gap-2"><input id="schedule-from" type="date" className="input" value={from} onChange={(event) => { setFrom(event.target.value); setOutboundScheduleId(''); setReturnScheduleId(''); }} /><span className="text-ink-muted">至</span><input type="date" className="input" value={to} onChange={(event) => { setTo(event.target.value); setOutboundScheduleId(''); setReturnScheduleId(''); }} /></div>
                    {rangeInvalid && <p className="mt-1 text-xs text-rose-600">起始日期不能晚于结束日期</p>}
                  </div>
                  <div>
                    <label className="label" htmlFor="poster-outbound">去程班次</label>
                    <select id="poster-outbound" className="input" value={outboundScheduleId} required disabled={scheduleLoading || rangeInvalid} onChange={(event) => { setOutboundScheduleId(event.target.value); setReturnScheduleId(''); }}>
                      <option value="">{scheduleLoading ? '班次加载中…' : '请选择去程班次'}</option>
                      {schedules.map((schedule) => <option key={schedule.id} value={schedule.id}>{formatSchedule(schedule)}</option>)}
                    </select>
                  </div>
                </div>
              </div>
              <div>
                <label className="label" htmlFor="poster-return">回程班次（选填）</label>
                <select id="poster-return" className="input" value={returnScheduleId} disabled={scheduleLoading || rangeInvalid} onChange={(event) => setReturnScheduleId(event.target.value)}>
                  <option value="">不选择（单程海报）</option>
                  {schedules.filter((schedule) => {
                    const outbound = schedules.find((item) => item.id === outboundScheduleId);
                    return Boolean(
                      outbound && schedule.id !== outbound.id &&
                      schedule.originCode === outbound.destinationCode &&
                      schedule.destinationCode === outbound.originCode &&
                      new Date(schedule.departureTime).getTime() > new Date(outbound.departureTime).getTime(),
                    );
                  }).map((schedule) => <option key={schedule.id} value={schedule.id}>{formatSchedule(schedule)}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="poster-effective">生效日期文案（选填）</label>
                <input id="poster-effective" className="input" maxLength={30} value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} placeholder="例：8月21日起" />
              </div>
              <div>
                <label className="label" htmlFor="poster-baggage">行李额文案（选填）</label>
                <input id="poster-baggage" className="input" maxLength={40} value={baggageText} onChange={(event) => setBaggageText(event.target.value)} placeholder="例：20KG+手提7KG" />
              </div>
              <div className="md:col-span-2">
                <label className="label" htmlFor="poster-note">补充要求（选填）</label>
                <textarea id="poster-note" className="input min-h-24 resize-y" maxLength={200} value={extraNote} onChange={(event) => setExtraNote(event.target.value)} placeholder="补充希望展示的语气、重点或限制" />
              </div>
            </div>
            {scheduleError && <div className="text-sm text-rose-700">{scheduleError}</div>}
            <div className="flex justify-end">
              <button type="submit" className="btn-primary" disabled={generating || scheduleLoading || rangeInvalid}>
                {generating ? `生成中… ${elapsedSeconds}s` : '生成海报'}
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="card p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div><h2 className="text-base font-semibold text-ink">海报列表</h2><p className="mt-0.5 text-xs text-ink-muted">列表不加载图片，查看详情时再读取大图</p></div>
          <div><label className="sr-only" htmlFor="poster-status">状态筛选</label><select id="poster-status" className="input py-1.5" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as StatusFilter); setPage(1); }}><option value="">全部状态</option>{(Object.keys(STATUS_LABEL) as MarketingPosterStatus[]).map((status) => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}</select></div>
        </div>
        {listError && <div className="mx-5 mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{listError}</div>}
        <div className="overflow-x-auto">
          <table className="table-admin min-w-[800px]">
            <thead><tr><th>名称</th><th>状态</th><th>版式</th><th>出图次数</th><th>创建人</th><th>创建时间</th><th>操作</th></tr></thead>
            <tbody>
              {listLoading ? <tr><td colSpan={7} className="py-10 text-center text-ink-muted">加载中…</td></tr> : posters.length === 0 ? <tr><td colSpan={7} className="py-10 text-center text-ink-muted">暂无海报</td></tr> : posters.map((poster) => <tr key={poster.id}><td className="font-medium text-ink">{poster.title}</td><td><span className={STATUS_BADGE[poster.status]}>{STATUS_LABEL[poster.status]}</span></td><td>{poster.templateKey}</td><td className="nums">{poster.attempts}</td><td>{poster.createdBy.displayName ?? '—'}</td><td>{formatDateTime(poster.createdAt)}</td><td><div className="flex gap-2"><button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={(event) => { detailTriggerRef.current = event.currentTarget; void openDetail(poster.id); }}>查看</button><button type="button" className="btn-ghost px-2.5 py-1 text-xs text-rose-700 hover:bg-rose-50" disabled={deleteId === poster.id} onClick={() => void deletePoster(poster)}>{deleteId === poster.id ? '删除中…' : '删除'}</button></div></td></tr>)}
            </tbody>
          </table>
        </div>
        <footer className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-sm text-ink-soft"><span>共 <span className="nums">{total}</span> 条 · 第 {page} / {totalPages} 页</span><div className="flex gap-2"><button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={page <= 1 || listLoading} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</button><button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={page >= totalPages || listLoading} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>下一页</button></div></footer>
      </section>

      {detailOpen && <PosterDetailModal detail={detail} loading={detailLoading} error={detailError} returnFocusRef={detailTriggerRef} onClose={closeDetail} />}
    </div>
  );
}
