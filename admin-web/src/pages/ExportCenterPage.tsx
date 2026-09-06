/**
 * 导出中心 —— 全系统 18 个导出的统一入口。
 *
 * 为什么有这一页：导出散在订单 / 航班 / 房控 / 签证台 / 财务 / 收款六个模块里，运营得记住
 * 每张表藏在哪个页面的哪个按钮后面，「功能早有只是没找到」因此成了反馈里的常客。这里按岗位
 * 把 18 个导出列全，写清每张表**给谁用、什么口径**，参数就地填、就地导。
 *
 * 边界：
 *   · 各页原有的导出按钮一个都没删 —— 这是并列的第二入口，不是替代；
 *   · 需要先勾选订单的（签证名单 / 护照包 / 单张订单 PNR）不在这里做，只给「去哪儿勾」的跳转；
 *   · 角色可见性只做导航 UX（少给入口 ≠ 放行），真闸在后端 requireRole / requireFinance /
 *     resolveExportAgentScope。
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type RangeSchedule } from '../lib/api';
import { formatDateTimeCn } from '../lib/datetime';
import { localYmd } from '../lib/airports';
import {
  RECENT_EXPORTS_KEY,
  appendRecentExport,
  groupExportEntries,
  parseRecentExports,
  type ExportEntry,
  type RecentExport,
} from '../lib/exportCatalog';
import { useAuth } from '../stores/auth';
import { Icon } from '../components/Icon';
import {
  EXPORT_TEMPLATE_LABEL,
  defaultExportParams,
  describeExportParams,
  exportParamsError,
  runExport,
  triggerBlobDownload,
  type ExportParams,
  type ScheduleMeta,
} from './exports/exportRunners';

/** 整班机导出的班次下拉往后看多少天（够覆盖在售团期，又不至于把全库班次拉回来）。 */
const SCHEDULE_LOOKAHEAD_DAYS = 90;
/** 也往回看几天：昨天刚飞的班，同事仍要补导名单。 */
const SCHEDULE_LOOKBACK_DAYS = 14;

function shiftDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function ExportCenterPage() {
  const user = useAuth((s) => s.user);
  const token = useAuth((s) => s.tokens?.accessToken) ?? '';

  const groups = useMemo(
    () => (user ? groupExportEntries({ role: user.role, staffRole: user.staffRole }) : []),
    [user],
  );
  const isAgent = user?.role === 'AGENT';
  const needsSchedules = useMemo(
    () => groups.some((g) => g.entries.some((e) => e.param === 'schedule')),
    [groups],
  );

  // ── 班次下拉数据（整班机导出唯一需要的列表）──
  // 复用座位统计页同一个端点，不为参数控件新开后端接口。
  const [schedules, setSchedules] = useState<RangeSchedule[]>([]);
  const [scheduleErr, setScheduleErr] = useState<string | null>(null);
  useEffect(() => {
    if (!token || !needsSchedules) return;
    let cancelled = false;
    api
      .listSchedulesInRange(token, {
        from: shiftDays(-SCHEDULE_LOOKBACK_DAYS),
        to: shiftDays(SCHEDULE_LOOKAHEAD_DAYS),
      })
      .then((r) => {
        if (!cancelled) setSchedules(r.schedules);
      })
      .catch(() => {
        // 班次列表拉不到只影响「整班机导出」这一张卡片，别让整页空掉
        if (!cancelled) setScheduleErr('班次列表加载失败，可到航班管理页按班次导出');
      });
    return () => {
      cancelled = true;
    };
  }, [token, needsSchedules]);

  // ── 最近导出（localStorage；隐私模式下存取会抛，降级为不记忆）──
  const [recent, setRecent] = useState<RecentExport[]>(() => {
    try {
      return parseRecentExports(localStorage.getItem(RECENT_EXPORTS_KEY));
    } catch {
      return [];
    }
  });
  const rememberExport = (item: RecentExport) => {
    setRecent((prev) => {
      const next = appendRecentExport(prev, item);
      try {
        localStorage.setItem(RECENT_EXPORTS_KEY, JSON.stringify(next));
      } catch {
        // 存不进去只影响记忆，不影响这次导出
      }
      return next;
    });
  };
  const clearRecent = () => {
    setRecent([]);
    try {
      localStorage.removeItem(RECENT_EXPORTS_KEY);
    } catch {
      // 同上
    }
  };

  const totalCount = groups.reduce((n, g) => n + g.entries.length, 0);

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <h1 className="page-title">导出中心</h1>
          <p className="page-sub">
            全系统能导的表都在这儿，按岗位分组，写清每张表给谁用、按什么口径出。
            参数就地填、就地导 —— 各页原来的导出按钮照旧能用，这里只是让你不用记它们在哪。
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <span className="badge-neutral">{totalCount} 张表</span>
          {isAgent && <span className="badge-info">代理视图</span>}
        </div>
      </section>

      {/* 分组跳转条：表多了以后，从顶部一步跳到自己那一摊 */}
      {groups.length > 1 && (
        <nav aria-label="按岗位跳转" className="flex flex-wrap gap-2">
          {groups.map((g) => (
            <a
              key={g.key}
              href={`#export-group-${g.key}`}
              className="rounded-full border border-slate-200 bg-surface px-3 py-1 text-xs font-medium text-ink-soft transition hover:border-brand/40 hover:bg-brand-50 hover:text-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              {g.label}
              <span className="ml-1 text-ink-muted">{g.entries.length}</span>
            </a>
          ))}
        </nav>
      )}

      {recent.length > 0 && <RecentExportsPanel items={recent} onClear={clearRecent} />}

      {groups.length === 0 && (
        <div className="card text-sm text-ink-muted">当前账号没有可用的导出。</div>
      )}

      {groups.map((group) => (
        <section key={group.key} id={`export-group-${group.key}`} className="scroll-mt-20">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-base font-semibold tracking-tight text-ink">{group.label}</h2>
            <span className="text-xs text-ink-muted">{group.hint}</span>
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            {group.entries.map((entry) => (
              <ExportCard
                key={entry.id}
                entry={entry}
                token={token}
                isAgent={isAgent}
                schedules={schedules}
                scheduleErr={scheduleErr}
                onExported={rememberExport}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ── 最近导出 ──────────────────────────────────────────────────────────
function RecentExportsPanel({ items, onClear }: { items: RecentExport[]; onClear: () => void }) {
  return (
    <section className="card">
      <div className="flex items-center justify-between">
        <h2 className="section-title">最近导出</h2>
        <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={onClear}>
          清空记录
        </button>
      </div>
      <p className="mt-0.5 text-xs text-ink-muted">
        只记在这台电脑的浏览器里（最多 20 条），方便回头核对「上次那份表是按什么条件导的」。
      </p>
      <ul className="mt-3 divide-y divide-slate-100">
        {items.map((r, i) => (
          <li
            key={`${r.at}-${i}`}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5"
          >
            <span className="text-sm font-medium text-ink">{r.name}</span>
            <span className="font-mono text-xs text-ink-soft">{r.filename}</span>
            {r.summary && <span className="text-xs text-ink-muted">{r.summary}</span>}
            <span className="ml-auto text-xs text-ink-muted">{formatDateTimeCn(r.at)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── 单张导出卡片 ──────────────────────────────────────────────────────
function ExportCard({
  entry,
  token,
  isAgent,
  schedules,
  scheduleErr,
  onExported,
}: {
  entry: ExportEntry;
  token: string;
  isAgent: boolean;
  schedules: RangeSchedule[];
  scheduleErr: string | null;
  onExported: (item: RecentExport) => void;
}) {
  const [params, setParams] = useState<ExportParams>(() => defaultExportParams(entry));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okAt, setOkAt] = useState<string | null>(null);

  const patch = (next: Partial<ExportParams>) => setParams((prev) => ({ ...prev, ...next }));

  const scheduleMeta = useMemo((): ScheduleMeta | undefined => {
    if (entry.param !== 'schedule' || !params.scheduleId) return undefined;
    const s = schedules.find((x) => x.id === params.scheduleId);
    if (!s) return undefined;
    return { flightNumber: s.flightNumber, date: localYmd(s.departureTime, s.departureTz) };
  }, [entry.param, params.scheduleId, schedules]);

  const validationError = exportParamsError(entry, params);

  async function handleExport(): Promise<void> {
    if (!token || busy) return;
    if (validationError) {
      setErr(validationError);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const { blob, filename } = await runExport(token, entry, params, scheduleMeta);
      triggerBlobDownload(blob, filename);
      const at = new Date().toISOString();
      setOkAt(at);
      onExported({
        id: entry.id,
        name: entry.name,
        filename,
        summary: describeExportParams(entry, params, scheduleMeta),
        at,
      });
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? `导出失败：${e.message}` : '导出失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="flex flex-col rounded-xl border border-slate-200 bg-surface p-4 shadow-card transition hover:border-brand/30">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink">{entry.name}</h3>
        <code className="shrink-0 rounded bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
          {entry.endpoint}
        </code>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-soft">{entry.desc}</p>
      {isAgent && entry.agentNote && (
        <p className="mt-1.5 rounded-md bg-brand-50 px-2 py-1 text-[11px] leading-relaxed text-brand-700">
          {entry.agentNote}
        </p>
      )}

      <div className="mt-auto pt-3">
        {entry.jumpTo ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-ink-muted">{entry.origin}</span>
            <Link to={entry.jumpTo.path} className="btn-secondary py-1.5 text-xs">
              <Icon name="chevronRight" size={14} /> {entry.jumpTo.label}
            </Link>
          </div>
        ) : (
          <>
            <ExportParamFields
              entry={entry}
              params={params}
              patch={patch}
              schedules={schedules}
              scheduleErr={scheduleErr}
              disabled={busy}
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] text-ink-muted">原入口：{entry.origin}</span>
              <button
                type="button"
                className="btn-primary py-1.5 text-xs"
                onClick={() => void handleExport()}
                disabled={busy || !token}
                title={validationError ?? `导出「${entry.name}」`}
              >
                {busy ? (
                  '导出中…'
                ) : (
                  <>
                    <Icon name="download" size={14} /> 导出
                  </>
                )}
              </button>
            </div>
          </>
        )}
        {err && <p className="mt-2 text-xs text-rose-600">{err}</p>}
        {!err && okAt && (
          <p className="mt-2 text-xs text-emerald-700">
            <Icon name="check" size={12} /> 已下载（{formatDateTimeCn(okAt)}）
          </p>
        )}
      </div>
    </article>
  );
}

// ── 参数控件（照抄各页现状：同样的控件、同样的默认值）────────────────
function ExportParamFields({
  entry,
  params,
  patch,
  schedules,
  scheduleErr,
  disabled,
}: {
  entry: ExportEntry;
  params: ExportParams;
  patch: (next: Partial<ExportParams>) => void;
  schedules: RangeSchedule[];
  scheduleErr: string | null;
  disabled: boolean;
}) {
  const dateField = (label: string, value: string, onChange: (v: string) => void) => (
    <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
      <span>{label}</span>
      <input
        type="date"
        className="input py-1.5 text-sm"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );

  switch (entry.param) {
    case 'none':
      return <p className="text-[11px] text-ink-muted">无需参数，点「导出」直接下载。</p>;

    case 'dateRange':
    case 'dateRangeOptional':
      return (
        <div className="grid grid-cols-2 gap-2">
          {dateField(
            entry.param === 'dateRangeOptional' ? '起始（可留空）' : '起始',
            params.from,
            (v) => patch({ from: v }),
          )}
          {dateField(
            entry.param === 'dateRangeOptional' ? '截止（可留空）' : '截止',
            params.to,
            (v) => patch({ to: v }),
          )}
        </div>
      );

    case 'seatStats':
      return (
        <div className="grid grid-cols-3 gap-2">
          {dateField('出发日 · 起', params.from, (v) => patch({ from: v }))}
          {dateField('出发日 · 止', params.to, (v) => patch({ to: v }))}
          <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
            <span>航班号（选填）</span>
            <input
              type="text"
              className="input py-1.5 text-sm"
              placeholder="如 QH9588"
              value={params.flightNumber}
              disabled={disabled}
              onChange={(e) => patch({ flightNumber: e.target.value })}
            />
          </label>
        </div>
      );

    case 'orderTemplate':
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
              <span>模板</span>
              <select
                className="input py-1.5 text-sm"
                value={params.template}
                disabled={disabled}
                onChange={(e) => patch({ template: e.target.value as ExportParams['template'] })}
              >
                {(Object.keys(EXPORT_TEMPLATE_LABEL) as Array<ExportParams['template']>).map((t) => (
                  <option key={t} value={t}>
                    《{EXPORT_TEMPLATE_LABEL[t]}》
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
              <span>航班号（选填）</span>
              <input
                type="text"
                className="input py-1.5 text-sm"
                placeholder="如 QH9588"
                value={params.flightNumber}
                disabled={disabled}
                onChange={(e) => patch({ flightNumber: e.target.value })}
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {dateField('出行日期 · 起（可留空）', params.from, (v) => patch({ from: v }))}
            {dateField('出行日期 · 止（可留空）', params.to, (v) => patch({ to: v }))}
          </div>
          <p className="text-[11px] text-ink-muted">
            日期留空 = 不按出行日期筛，导命中的全部订单。
          </p>
        </div>
      );

    case 'orderMaster':
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            {dateField('出行日期 · 起', params.from, (v) => patch({ from: v }))}
            {dateField('出行日期 · 止', params.to, (v) => patch({ to: v }))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {dateField('下单时间 · 起', params.createdFrom, (v) => patch({ createdFrom: v }))}
            {dateField('下单时间 · 止', params.createdTo, (v) => patch({ createdTo: v }))}
          </div>
          <p className="text-[11px] text-ink-muted">
            出行日期 = 客人哪天走；下单时间 = 单子哪天录进来。两个是独立条件，都留空 = 全部。
          </p>
        </div>
      );

    case 'orderIntake':
      return (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            {dateField('下单时间 · 起', params.createdFrom, (v) => patch({ createdFrom: v }))}
            {dateField('下单时间 · 止', params.createdTo, (v) => patch({ createdTo: v }))}
          </div>
          <p className="text-[11px] text-ink-muted">按录入周期统计，留空 = 全部。</p>
        </div>
      );

    case 'roomAllocation':
      return (
        <div className="space-y-2">
          <div className="flex gap-3 text-[11px] text-ink-soft">
            <label className="inline-flex items-center gap-1">
              <input
                type="radio"
                name={`room-mode-${entry.id}`}
                checked={params.roomMode === 'range'}
                disabled={disabled}
                onChange={() => patch({ roomMode: 'range' })}
              />
              按入住区间
            </label>
            <label className="inline-flex items-center gap-1">
              <input
                type="radio"
                name={`room-mode-${entry.id}`}
                checked={params.roomMode === 'depart'}
                disabled={disabled}
                onChange={() => patch({ roomMode: 'depart' })}
              />
              按出发日
            </label>
          </div>
          {params.roomMode === 'depart' ? (
            <div className="grid grid-cols-2 gap-2">
              {dateField('出发日期', params.departDate, (v) => patch({ departDate: v }))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {dateField('入住 · 起', params.from, (v) => patch({ from: v }))}
              {dateField('入住 · 止（最长 14 天）', params.to, (v) => patch({ to: v }))}
            </div>
          )}
        </div>
      );

    case 'schedule':
      return (
        <label className="flex flex-col gap-1 text-[11px] text-ink-muted">
          <span>班次</span>
          <select
            className="input py-1.5 text-sm"
            value={params.scheduleId}
            disabled={disabled || schedules.length === 0}
            onChange={(e) => patch({ scheduleId: e.target.value })}
          >
            <option value="">请选择班次…</option>
            {schedules.map((s) => (
              <option key={s.id} value={s.id}>
                {localYmd(s.departureTime, s.departureTz)} · {s.flightNumber} · {s.originCode}→
                {s.destinationCode}
              </option>
            ))}
          </select>
          {scheduleErr ? (
            <span className="text-amber-700">{scheduleErr}</span>
          ) : (
            <span>
              近 {SCHEDULE_LOOKBACK_DAYS} 天至未来 {SCHEDULE_LOOKAHEAD_DAYS} 天的班次
            </span>
          )}
        </label>
      );

    default:
      return null;
  }
}
