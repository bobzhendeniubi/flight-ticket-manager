/**
 * no-show 处理（批量）· ADMIN/STAFF
 *
 * 场景：航班起飞后航司给来一份未登机名单，票务贴进来一次性标完，顺带把回程座位放回库存。
 *
 * 口径与边界（都由服务端把关，本页只做勾选与展示）：
 *   - 能不能标（eligible / blockers）、要不要先拆单（scope）、能释放几座，全部以 preview 为准；
 *     前端不自己判，判出来的第二套口径必然漂移。
 *   - 未起飞的班次不给提交：起飞前谁也说不准客人到底登不登机。起飞与否以 preview 的
 *     schedule.departed 为准，本机时间只在选班次时给个提示。
 *   - requestToken 是幂等键，按提交载荷指纹记忆化：「重试失败项」原样重发同一批载荷，
 *     已成功的单不会被再执行一遍；改了勾选 / 释放开关 / 备注才换新键。
 *   - 护照只显示服务端下发的尾号。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type NoShowBatchPreview,
  type NoShowBatchResponse,
  type RangeSchedule,
} from '../lib/api';
import { formatLocalTime, localYmd } from '../lib/airports';
import { useAuth } from '../stores/auth';
import { useConfirm } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { NoShowTabs } from './no-show/NoShowTabs';
import { NoShowMatchTable } from './no-show/NoShowMatchTable';
import { NoShowUnresolvedPanels } from './no-show/NoShowUnresolvedPanels';
import {
  buildEntries,
  defaultSelectedKeys,
  matchKey,
  newRequestToken,
  parseNameLines,
  payloadFingerprint,
  summarizeSelection,
} from './no-show/noShowMatch';

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function NoShowBatchPage() {
  const token = useAuth((s) => s.tokens?.accessToken) ?? '';
  const confirm = useConfirm();

  // ── 选班次 ────────────────────────────────────────────────────────────
  const [date, setDate] = useState(todayYmd());
  const [schedules, setSchedules] = useState<RangeSchedule[]>([]);
  const [schedulesLoading, setSchedulesLoading] = useState(false);
  const [schedulesError, setSchedulesError] = useState<string | null>(null);
  const [flightNumber, setFlightNumber] = useState('');
  const [scheduleId, setScheduleId] = useState('');

  useEffect(() => {
    if (!token || !date) return;
    let cancelled = false;
    setSchedulesLoading(true);
    setSchedulesError(null);
    api
      .listSchedulesInRange(token, { from: date, to: date })
      .then((res) => {
        if (cancelled) return;
        setSchedules(res.schedules);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setSchedules([]);
        setSchedulesError(e instanceof ApiError ? e.message : '加载班次失败');
      })
      .finally(() => {
        if (!cancelled) setSchedulesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, date]);

  const flightNumbers = useMemo(
    () => Array.from(new Set(schedules.map((s) => s.flightNumber))).sort(),
    [schedules],
  );

  const candidateSchedules = useMemo(() => {
    const list = flightNumber ? schedules.filter((s) => s.flightNumber === flightNumber) : schedules;
    return [...list].sort((a, b) => a.departureTime.localeCompare(b.departureTime));
  }, [schedules, flightNumber]);

  // 换日期/换航班后，原先选中的班次可能已不在候选里 —— 只剩一个时自动选上，否则清空。
  useEffect(() => {
    setScheduleId((prev) => {
      if (prev && candidateSchedules.some((s) => s.id === prev)) return prev;
      return candidateSchedules.length === 1 ? candidateSchedules[0].id : '';
    });
  }, [candidateSchedules]);

  const selectedSchedule = candidateSchedules.find((s) => s.id === scheduleId) ?? null;
  // 本机时间只作提示；真正的闸走 preview.schedule.departed。
  const looksDeparted = selectedSchedule
    ? new Date(selectedSchedule.departureTime).getTime() < Date.now()
    : false;

  // ── 名单与匹配 ────────────────────────────────────────────────────────
  const [namesText, setNamesText] = useState('');
  const [preview, setPreview] = useState<NoShowBatchPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [ambiguousChoices, setAmbiguousChoices] = useState<Record<string, string>>({});

  // ── 提交 ──────────────────────────────────────────────────────────────
  const [releaseReturn, setReleaseReturn] = useState(true);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<NoShowBatchResponse | null>(null);
  // 幂等键记忆：同一份载荷（含重试）复用同一个 token
  const tokenMemo = useRef<{ fingerprint: string; value: string } | null>(null);

  const nameLines = useMemo(() => parseNameLines(namesText), [namesText]);

  const resetMatch = useCallback(() => {
    setPreview(null);
    setSelectedKeys(new Set());
    setAmbiguousChoices({});
    setResult(null);
    setSubmitError(null);
  }, []);

  // 换班次 = 换了一整批上下文，之前的匹配结果全部作废
  useEffect(() => {
    resetMatch();
  }, [scheduleId, resetMatch]);

  const handleMatch = async () => {
    if (!token || !scheduleId || nameLines.length === 0) return;
    setPreviewLoading(true);
    setPreviewError(null);
    setResult(null);
    setSubmitError(null);
    try {
      const res = await api.noShow.batchPreview(token, { scheduleId, names: nameLines });
      setPreview(res);
      setSelectedKeys(defaultSelectedKeys(res.matched));
      setAmbiguousChoices({});
    } catch (e) {
      setPreview(null);
      setSelectedKeys(new Set());
      setPreviewError(e instanceof ApiError ? e.message : '匹配失败，请稍后重试');
    } finally {
      setPreviewLoading(false);
    }
  };

  const toggleKey = (key: string, checked: boolean) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    if (!preview) return;
    setSelectedKeys(
      checked ? new Set(preview.matched.filter((m) => m.eligible).map(matchKey)) : new Set(),
    );
  };

  const applyAmbiguousChoice = (line: string, replacement: string) => {
    setNamesText((prev) =>
      prev
        .split(/\r?\n/)
        .map((raw) => (raw.trim() === line ? replacement : raw))
        .join('\n'),
    );
    // 名单变了，旧的匹配结果不再对得上，收起来等重新匹配
    resetMatch();
  };

  const selectedMatches = useMemo(
    () => (preview ? preview.matched.filter((m) => selectedKeys.has(matchKey(m))) : []),
    [preview, selectedKeys],
  );
  const summary = useMemo(
    () => summarizeSelection(selectedMatches, releaseReturn),
    [selectedMatches, releaseReturn],
  );
  const entries = useMemo(() => buildEntries(selectedMatches), [selectedMatches]);

  // 起飞与否：拿到 preview 后以服务端为准
  const departed = preview ? preview.schedule.departed : looksDeparted;
  const canSubmit = Boolean(token) && entries.length > 0 && departed && !submitting;

  const runSubmit = useCallback(async () => {
    if (!token || !scheduleId || entries.length === 0) return;
    const fingerprint = payloadFingerprint({ scheduleId, entries, releaseReturn, note });
    if (tokenMemo.current?.fingerprint !== fingerprint) {
      tokenMemo.current = { fingerprint, value: newRequestToken() };
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api.noShow.batch(token, {
        requestToken: tokenMemo.current.value,
        scheduleId,
        entries,
        releaseReturn,
        note: note.trim() || undefined,
      });
      setResult(res);
    } catch (e) {
      setSubmitError(e instanceof ApiError ? e.message : '提交失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }, [token, scheduleId, entries, releaseReturn, note]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const ok = await confirm({
      title: '确认标记 no-show？',
      tone: 'danger',
      confirmText: '确认标记',
      body: `本次将标记 ${summary.pax} 人 / ${summary.orders} 张单${
        summary.splitOrders > 0 ? `，其中 ${summary.splitOrders} 张会先自动拆单` : ''
      }。\n\n${
        releaseReturn
          ? `同时释放回程座位（预计 ${summary.estimatedReleasedSeats} 座回到库存重新可卖）。已出票的回程会开出撤名单 / 退票工单。`
          : '不释放回程座位：回程仍然占着库存。'
      }\n\n去程钱不动。标错了只能逐单人工恢复，提交前请再核一遍名单。`,
    });
    if (!ok) return;
    await runSubmit();
  };

  const failedResults = result?.results.filter((r) => !r.ok) ?? [];

  return (
    <div className="space-y-5">
      <section>
        <h1 className="page-title">no-show 处理</h1>
        <p className="page-sub">
          航班起飞后，把航司给的未登机名单贴进来一次性标记：去程标 no-show（<strong>钱不动</strong>），
          回程座位可同时放回库存重新可卖。能不能标、要不要先拆单、能释放几座，全部以系统匹配结果为准。
        </p>
      </section>

      <NoShowTabs />

      {/* ── 1. 选班次 ── */}
      <section className="card">
        <h2 className="section-title">1 · 选班次</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <div>
            <label className="label" htmlFor="no-show-date">
              出发日期
            </label>
            <input
              id="no-show-date"
              type="date"
              className="input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="no-show-flight">
              航班号
            </label>
            <select
              id="no-show-flight"
              className="input"
              value={flightNumber}
              onChange={(e) => setFlightNumber(e.target.value)}
            >
              <option value="">全部航班</option>
              {flightNumbers.map((fn) => (
                <option key={fn} value={fn}>
                  {fn}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="no-show-schedule">
              班次
            </label>
            <select
              id="no-show-schedule"
              className="input"
              value={scheduleId}
              onChange={(e) => setScheduleId(e.target.value)}
              disabled={candidateSchedules.length === 0}
            >
              <option value="">
                {schedulesLoading
                  ? '加载中…'
                  : candidateSchedules.length === 0
                    ? '当日无班次'
                    : '请选择班次'}
              </option>
              {candidateSchedules.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.flightNumber} · {formatLocalTime(s.departureTime, s.departureTz)} ·{' '}
                  {s.originCode}→{s.destinationCode}
                </option>
              ))}
            </select>
          </div>
        </div>

        {schedulesError && <p className="mt-2 text-sm text-rose-700">{schedulesError}</p>}

        {selectedSchedule && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-semibold text-ink">{selectedSchedule.flightNumber}</span>
              <span className="text-ink-soft">
                {selectedSchedule.originCode}→{selectedSchedule.destinationCode}
              </span>
              <span className="nums text-ink-soft">
                {localYmd(selectedSchedule.departureTime, selectedSchedule.departureTz)}{' '}
                {formatLocalTime(selectedSchedule.departureTime, selectedSchedule.departureTz)}
              </span>
              <span className="text-ink-soft">
                已售{' '}
                <span className="nums font-medium text-ink">
                  {preview
                    ? preview.schedule.seatsSold
                    : selectedSchedule.seatClasses.reduce((sum, c) => sum + c.sold, 0)}
                </span>{' '}
                座
              </span>
              {departed ? (
                <span className="badge-neutral">已起飞</span>
              ) : (
                <span className="badge-warning">未起飞</span>
              )}
            </div>
            {!departed && (
              <p className="mt-1.5 text-xs text-amber-700">
                <Icon name="alert" /> 本班次还没起飞，不能标 no-show —— 起飞前谁也说不准客人到底登不登机。
                可以先贴名单做匹配核对，起飞后再回来提交。
              </p>
            )}
          </div>
        )}
      </section>

      {/* ── 2. 贴名单 ── */}
      <section className="card">
        <h2 className="section-title">2 · 贴未登机名单</h2>
        <p className="mt-0.5 text-xs text-ink-muted">
          一行一个，支持证件姓名 / 中文名 / 护照号（护照号最准，姓名可能撞同名）。空行与重复行自动忽略。
        </p>
        <textarea
          className="input mt-2 h-40 font-mono text-xs"
          placeholder={'ZHANG SAN\n李四\nE12345678'}
          value={namesText}
          onChange={(e) => setNamesText(e.target.value)}
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-primary text-sm"
            disabled={!scheduleId || nameLines.length === 0 || previewLoading}
            onClick={() => void handleMatch()}
          >
            <Icon name="check" /> {previewLoading ? '匹配中…' : '匹配'}
          </button>
          <span className="text-sm text-ink-muted">
            共 <span className="nums font-medium text-ink">{nameLines.length}</span> 行
          </span>
          {!scheduleId && <span className="text-xs text-amber-700">请先选班次</span>}
        </div>
        {previewError && <p className="mt-2 text-sm text-rose-700">{previewError}</p>}
      </section>

      {/* ── 3. 匹配结果 ── */}
      {preview && (
        <>
          <section className="card p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
              <h2 className="section-title">
                3 · 匹配结果（{preview.matched.length} 行命中 / 已勾 {summary.pax} 人）
              </h2>
              <span className="text-xs text-ink-muted">不合格的行已灰掉，原因见最后一列</span>
            </div>
            <NoShowMatchTable
              matched={preview.matched}
              selectedKeys={selectedKeys}
              onToggle={toggleKey}
              onToggleAll={toggleAll}
            />
          </section>

          <NoShowUnresolvedPanels
            unmatched={preview.unmatched}
            ambiguous={preview.ambiguous}
            choices={ambiguousChoices}
            onChoose={(line, passengerId) =>
              setAmbiguousChoices((prev) => ({ ...prev, [line]: passengerId }))
            }
            onApplyChoice={applyAmbiguousChoice}
          />

          {/* ── 4. 提交 ── */}
          <section className="card">
            <h2 className="section-title">4 · 确认提交</h2>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={releaseReturn}
                  onChange={(e) => setReleaseReturn(e.target.checked)}
                />
                <span className="text-sm">
                  <span className="font-medium text-ink">同时释放回程座位</span>
                  <span className="mt-0.5 block text-xs text-ink-muted">
                    把回程座位放回库存重新可卖（钱不动）。已出票的回程会开出撤名单 / 退票工单；
                    代理事后来要，运营仍可逐单恢复。
                  </span>
                </span>
              </label>
              <div>
                <label className="label" htmlFor="no-show-note">
                  备注（选填）
                </label>
                <input
                  id="no-show-note"
                  className="input"
                  placeholder="如：航司名单来源 / 批次号"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </div>

            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-sm text-ink-soft">
              将标记 <span className="nums font-semibold text-ink">{summary.pax}</span> 人 /{' '}
              <span className="nums font-semibold text-ink">{summary.orders}</span> 张单，预计释放{' '}
              <span className="nums font-semibold text-ink">{summary.estimatedReleasedSeats}</span> 座
              {summary.splitOrders > 0 ? (
                <>
                  ，其中{' '}
                  <span className="nums font-semibold text-amber-700">{summary.splitOrders}</span>{' '}
                  张需先自动拆单
                </>
              ) : (
                <>，无需拆单</>
              )}
              。
              <span className="mt-1 block text-xs text-ink-muted">
                释放座位数为预估（勾了释放 × 还有未起飞回程的人数），实际以提交后的返回为准。
              </span>
            </div>

            {submitError && <p className="mt-2 text-sm text-rose-700">{submitError}</p>}

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn-danger text-sm"
                disabled={!canSubmit}
                onClick={() => void handleSubmit()}
              >
                {submitting ? '提交中…' : '标记 no-show'}
              </button>
              {!departed && <span className="text-xs text-amber-700">班次未起飞，暂不能提交</span>}
              {departed && entries.length === 0 && (
                <span className="text-xs text-ink-muted">还没勾选任何乘客</span>
              )}
            </div>
          </section>
        </>
      )}

      {/* ── 5. 提交结果 ── */}
      {result && (
        <section className="card p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
            <h2 className="section-title">
              提交结果 · 成功 {result.summary.ok} 张 / 失败 {result.summary.failed} 张 · 实际释放{' '}
              {result.summary.releasedSeats} 座
            </h2>
            {failedResults.length > 0 && (
              <button
                type="button"
                className="btn-secondary py-1 text-xs"
                disabled={submitting}
                onClick={() => void runSubmit()}
                title="原样重发同一批载荷（幂等键不变）：已成功的单不会被重复执行，只重试失败的"
              >
                <Icon name="refresh" /> 重试失败项（{failedResults.length}）
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="table-admin">
              <thead>
                <tr>
                  <th className="text-left">订单号</th>
                  <th className="text-left">结果</th>
                  <th className="text-left">拆出的新单</th>
                  <th className="text-right">释放座位</th>
                  <th className="text-left">工单</th>
                  <th className="text-left">失败原因</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((r) => (
                  <tr key={`${r.orderId}-${r.orderNumber}`}>
                    <td className="nums">{r.orderNumber}</td>
                    <td>
                      {r.ok ? (
                        <span className="badge-success">已标记</span>
                      ) : (
                        <span className="badge-danger">失败</span>
                      )}
                    </td>
                    <td className="nums">{r.targetOrderNumber ?? '—'}</td>
                    <td className="nums text-right">{r.releasedSeats ?? 0}</td>
                    <td>
                      {r.workOrderReminderId ? (
                        <span className="badge-info" title="已开出撤名单 / 退票工单，见顶栏工单角标">
                          已开工单
                        </span>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="text-rose-700">
                      {r.error ?? '—'}
                      {r.code && <span className="ml-1 text-xs text-ink-muted">({r.code})</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
