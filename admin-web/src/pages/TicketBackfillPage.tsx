/**
 * 票号批量回填 · ADMIN/STAFF
 *
 * 场景：出票代理把一班几十人的出票单发回来，票务岗一次性把真实 PNR / 电子票号灌回系统。
 * 单独改某一个人走订单详情乘客卡上的「票号」按钮，这一页是整班的。
 *
 * 口径与边界（都由服务端把关，本页只做勾选与展示）：
 *   - 谁是谁（护照号优先、姓名兜底、撞名不猜）、库里现在是什么号、算不算冲突，全部以 preview 为准；
 *     前端不自己判，判出来的第二套口径必然漂移。
 *   - 冲突行（库里已有不同的号）默认**不勾**，且必须先打开「允许覆盖已有票号」才提交得动 ——
 *     覆盖别人录好的票号得是人主动做的事，不能靠「默认全勾 + 没人细看」滑过去。
 *   - 回填**不会**给客人发行程单邮件。要发去订单详情点「重发行程单邮件」，人点、人负责。
 *   - 提交按 200 条一片顺序连发，每片按载荷指纹记忆 requestToken：「重试失败项」原样重发同一批
 *     载荷时复用同一个 token，事后在审计里认得出是同一批。写值本身幂等，重发不会写坏已经对的号。
 *   - 护照只显示服务端下发的尾号。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type RangeSchedule,
  type TicketBatchEntry,
  type TicketBatchPreview,
  type TicketBatchResult,
} from '../lib/api';
import { formatLocalTime, localYmd } from '../lib/airports';
import { useAuth } from '../stores/auth';
import { useConfirm } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { TicketMatchTable } from './ticket-backfill/TicketMatchTable';
import {
  buildEntries,
  chunkEntries,
  defaultSelectedKeys,
  fileToBase64,
  isSubmittable,
  matchKey,
  newRequestToken,
  payloadFingerprint,
  summarizeSelection,
  TICKET_BATCH_CHUNK_SIZE,
} from './ticket-backfill/ticketBackfill';

function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const PLACEHOLDER = ['E12345678, 7QRS9K, 784-1234567890', 'ZHANG SAN, ABC12, 7841234567891'].join(
  '\n',
);

export function TicketBackfillPage() {
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
        if (!cancelled) setSchedules(res.schedules);
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

  // ── 名单与匹配 ────────────────────────────────────────────────────────
  const [rosterText, setRosterText] = useState('');
  const [uploadName, setUploadName] = useState<string | null>(null);
  const [preview, setPreview] = useState<TicketBatchPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [allowOverwrite, setAllowOverwrite] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── 提交 ──────────────────────────────────────────────────────────────
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [results, setResults] = useState<TicketBatchResult[] | null>(null);
  const [submitProgress, setSubmitProgress] = useState<{ done: number; total: number } | null>(null);
  // 幂等键记忆：**按片**记 —— 同一片载荷（含重试）复用同一个 token。
  const tokenMemo = useRef<Map<string, string>>(new Map());

  const resetMatch = useCallback(() => {
    setPreview(null);
    setSelectedKeys(new Set());
    setResults(null);
    setSubmitError(null);
    setSubmitProgress(null);
  }, []);

  // 换班次 = 换了一整批上下文，之前的匹配结果全部作废
  useEffect(() => {
    resetMatch();
  }, [scheduleId, resetMatch]);

  const runPreview = useCallback(
    async (body: { lines?: string; fileBase64?: string }) => {
      if (!token || !scheduleId) return;
      setPreviewLoading(true);
      setPreviewError(null);
      setResults(null);
      setSubmitError(null);
      setSubmitProgress(null);
      try {
        const res = await api.ticketBackfill.batchPreview(token, { scheduleId, ...body });
        setPreview(res);
        setSelectedKeys(defaultSelectedKeys(res.matched));
      } catch (e) {
        setPreview(null);
        setPreviewError(e instanceof ApiError ? e.message : '匹配失败，请稍后重试');
      } finally {
        setPreviewLoading(false);
      }
    },
    [token, scheduleId],
  );

  const handleUpload = async (file: File | null): Promise<void> => {
    if (!file) return;
    setUploadName(file.name);
    // 上传的表格不往 textarea 里灌（几百行贴进去只会挡住页面）；
    // 服务端把每行的单元格用 Tab 拼起来后走的是同一个解析器，结果与粘贴完全一致。
    setRosterText('');
    try {
      const fileBase64 = await fileToBase64(file);
      await runPreview({ fileBase64 });
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : '文件读取失败');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const toggleKey = (key: string): void => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = (checked: boolean): void => {
    if (!preview) return;
    setSelectedKeys(
      checked ? new Set(preview.matched.filter(isSubmittable).map(matchKey)) : new Set(),
    );
  };

  const matched = useMemo(() => preview?.matched ?? [], [preview]);
  const selection = useMemo(
    () => summarizeSelection(matched, selectedKeys),
    [matched, selectedKeys],
  );
  // 勾了冲突行却没开覆盖开关：这些条目提交上去会被服务端逐条 TICKET_CONFLICT 挡回来，
  // 与其让人点完再看一屏红字，不如在按钮上就说清楚。
  const blockedByOverwrite = !allowOverwrite && selection.overwrites > 0;

  const runSubmit = async (entriesOverride?: TicketBatchEntry[]): Promise<void> => {
    if (!token || !scheduleId || submitting) return;
    const entries = entriesOverride ?? buildEntries(matched, selectedKeys, allowOverwrite);
    if (entries.length === 0) return;
    const chunks = chunkEntries(entries);
    setSubmitting(true);
    setSubmitError(null);
    setSubmitProgress({ done: 0, total: chunks.length });
    const collected: TicketBatchResult[] = [];
    try {
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const fingerprint = payloadFingerprint(scheduleId, chunk);
        let requestToken = tokenMemo.current.get(fingerprint);
        if (!requestToken) {
          requestToken = newRequestToken();
          tokenMemo.current.set(fingerprint, requestToken);
        }
        const res = await api.ticketBackfill.batch(token, {
          requestToken,
          scheduleId,
          entries: chunk,
          ...(note.trim() ? { note: note.trim() } : {}),
        });
        collected.push(...res.results);
        setSubmitProgress({ done: i + 1, total: chunks.length });
      }
      // 写完了重新拉一次匹配：库里现值变了，「现有 → 新值」两列必须跟着变，
      // 否则票务看着一屏「待覆盖」，其实已经写进去了。
      //
      // ⚠ 顺序不能反：runPreview 开头会清空 results（换一份名单重新匹配时本就该清），
      // 所以「本次回填了多少条」必须**等它跑完之后**再写回去 —— 先写会被这次刷新抹掉，
      // 票务点完提交只看到一屏刷新后的表，完全不知道刚才成了几条。
      if (rosterText.trim()) await runPreview({ lines: rosterText });
      setResults(collected);
    } catch (e) {
      // 已经成功的片不回滚（服务端一条一事务）；把已收到的结果照实摆出来。
      if (collected.length > 0) setResults(collected);
      setSubmitError(e instanceof ApiError ? e.message : '提交失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (): Promise<void> => {
    const entries = buildEntries(matched, selectedKeys, allowOverwrite);
    if (entries.length === 0) return;
    const chunkCount = chunkEntries(entries).length;
    const chunkNote =
      chunkCount > 1
        ? `\n\n本次分 ${chunkCount} 批发送（每批最多 ${TICKET_BATCH_CHUNK_SIZE} 条），中途失败的批不影响其它批。`
        : '';
    const ok = await confirm({
      title: '确认回填票号？',
      tone: selection.overwrites > 0 ? 'danger' : undefined,
      confirmText: '确认回填',
      body:
        `本次将为 ${selection.pax} 位出行人（${selection.orders} 张单）写入 PNR / 电子票号。` +
        (selection.overwrites > 0
          ? `\n\n其中 ${selection.overwrites} 位已有不同的票号，会被名单里的号覆盖 —— 覆盖后原来的号只在审计里查得到。`
          : '') +
        `${chunkNote}\n\n回填不会给客人发行程单邮件；需要时请到订单详情点「重发行程单邮件」。`,
    });
    if (!ok) return;
    await runSubmit();
  };

  const failedResults = useMemo(() => results?.filter((r) => !r.ok) ?? [], [results]);
  const okResults = results?.filter((r) => r.ok) ?? [];
  const changedCount = okResults.filter((r) => r.changedFields.length > 0).length;
  const unchangedCount = okResults.length - changedCount;

  const retryFailed = async (): Promise<void> => {
    // 失败项按**当前**勾选口径重建条目：改了覆盖开关再点重试，就是按新口径重来一遍。
    const failedKeys = new Set(failedResults.map((r) => `${r.orderId}:${r.passengerId}`));
    const entries = buildEntries(
      matched.filter((m) => failedKeys.has(matchKey(m))),
      selectedKeys,
      allowOverwrite,
    );
    if (entries.length === 0) {
      setSubmitError('失败项在当前勾选里已经没有可提交的条目了，请重新匹配后再试。');
      return;
    }
    await runSubmit(entries);
  };

  return (
    <div className="space-y-5">
      <section>
        <h1 className="page-title">票号批量回填</h1>
        <p className="page-sub">
          航司/出票代理把出票单发回来后，票务岗在这里选班次、贴名单，一次把真实 PNR 与电子票号灌回系统。
          单独改某一位客人走订单详情乘客卡上的「票号」。<strong>回填不会给客人发行程单邮件</strong>。
        </p>
      </section>

      {/* ── 1. 选班次 ── */}
      <section className="card">
        <h2 className="section-title">1 · 选班次</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <div>
            <label className="label" htmlFor="ticket-date">
              出发日期
            </label>
            <input
              id="ticket-date"
              type="date"
              className="input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="ticket-flight">
              航班号
            </label>
            <select
              id="ticket-flight"
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
            <label className="label" htmlFor="ticket-schedule">
              班次
            </label>
            <select
              id="ticket-schedule"
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
            </div>
            <p className="mt-1.5 text-xs text-ink-muted">
              去程与回程挂在这一班的单都会进匹配池 —— 票号是按人记的，不分航段。
            </p>
          </div>
        )}
      </section>

      {/* ── 2. 贴名单 ── */}
      <section className="card">
        <h2 className="section-title">2 · 贴出票名单</h2>
        <p className="mt-0.5 text-xs text-ink-muted">
          一行一个人：<span className="font-mono">护照号或姓名, PNR, 票号</span>。 分隔符逗号 / Tab /
          空格都认；票号上 <span className="font-mono">784-</span> 的横杠可省可留； 只有票号没有 PNR
          也收。表头行会自动跳过。
        </p>
        <p className="mt-1 text-xs text-amber-700">
          <Icon name="alert" /> 只用空格分隔、且 PNR 是<strong>纯字母</strong>时，
          系统分不清它是订座编码还是姓氏，会整段当成姓名（那一行会落进「未匹配」）。
          这种名单请改用逗号 / Tab 分列，或直接传表格。
        </p>
        <textarea
          className="input mt-2 h-40 font-mono text-xs"
          placeholder={PLACEHOLDER}
          value={rosterText}
          onChange={(e) => {
            setRosterText(e.target.value);
            setUploadName(null);
          }}
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-primary text-sm"
            disabled={!scheduleId || rosterText.trim() === '' || previewLoading}
            onClick={() => void runPreview({ lines: rosterText })}
          >
            <Icon name="check" /> {previewLoading ? '匹配中…' : '匹配'}
          </button>
          <label className="btn-ghost cursor-pointer text-sm">
            <Icon name="upload" /> 上传 .xlsx
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              disabled={!scheduleId || previewLoading}
              onChange={(e) => void handleUpload(e.target.files?.[0] ?? null)}
            />
          </label>
          {uploadName && <span className="text-xs text-ink-soft">已上传：{uploadName}</span>}
          {!scheduleId && <span className="text-xs text-amber-700">请先选班次</span>}
        </div>
        {previewError && <p className="mt-2 text-sm text-rose-700">{previewError}</p>}
      </section>

      {/* ── 3. 匹配结果 ── */}
      {preview && (
        <>
          {preview.truncated && (
            <section className="card border-rose-300 bg-rose-50/70">
              <p className="text-sm font-semibold text-rose-700">
                名单共 <span className="nums">{preview.totalLines}</span> 行，本次只处理了前{' '}
                <span className="nums">{preview.processedLines}</span> 行，请分批。
              </p>
              <p className="mt-1 text-xs text-rose-700">
                剩下的{' '}
                <span className="nums">
                  {Math.max(0, preview.totalLines - preview.processedLines)}
                </span>{' '}
                行这次<strong>没有</strong>参与匹配，也不会被回填。先把这一批灌完，再贴剩下的。
              </p>
            </section>
          )}

          <section className="card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="section-title">3 · 核对并勾选</h2>
              <div className="text-xs text-ink-soft">
                匹配 <span className="nums font-medium text-ink">{preview.matched.length}</span> 人 ·
                未匹配 <span className="nums">{preview.unmatched.length}</span> 行 · 格式有问题{' '}
                <span className="nums">{preview.invalid.length}</span> 行 · 同名待处理{' '}
                <span className="nums">{preview.ambiguous.length}</span> 行
              </div>
            </div>
            <div className="mt-3">
              <TicketMatchTable
                matched={preview.matched}
                selected={selectedKeys}
                onToggle={toggleKey}
                onToggleAll={toggleAll}
              />
            </div>
          </section>

          {(preview.unmatched.length > 0 ||
            preview.invalid.length > 0 ||
            preview.ambiguous.length > 0) && (
            <section className="card">
              <h2 className="section-title">需要人工处理的行</h2>
              {preview.invalid.length > 0 && (
                <div className="mt-3">
                  <h3 className="text-sm font-medium text-rose-700">
                    格式有问题（{preview.invalid.length} 行）
                  </h3>
                  <ul className="mt-1 space-y-1 text-xs">
                    {preview.invalid.map((r) => (
                      <li key={r.line} className="text-ink-soft">
                        <span className="font-mono">{r.line}</span>
                        <span className="ml-2 text-rose-700">{r.error}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {preview.unmatched.length > 0 && (
                <div className="mt-3">
                  <h3 className="text-sm font-medium text-ink">
                    这一班里找不到这个人（{preview.unmatched.length} 行）
                  </h3>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    可能是别班的人，也可能名字/护照号与系统里录的不一样。
                  </p>
                  <ul className="mt-1 space-y-0.5 font-mono text-xs text-ink-soft">
                    {preview.unmatched.map((r) => (
                      <li key={r.line}>{r.line}</li>
                    ))}
                  </ul>
                </div>
              )}
              {preview.ambiguous.length > 0 && (
                <div className="mt-3">
                  <h3 className="text-sm font-medium text-amber-800">
                    同名撞车，系统不猜（{preview.ambiguous.length} 行）
                  </h3>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    这几行匹配到了多位乘客。请把名单里这几行改成<strong>护照号</strong>再匹配一次 ——
                    猜错就是把票号写到另一个人的单子上。
                  </p>
                  <ul className="mt-1 space-y-1 text-xs">
                    {preview.ambiguous.map((a) => (
                      <li key={a.line}>
                        <span className="font-mono text-ink-soft">{a.line}</span>
                        <span className="ml-2 text-ink-muted">
                          候选：
                          {a.candidates
                            .map(
                              (c) =>
                                `${c.fullName}（${c.orderNumber} · 尾号 ${c.documentTail || '—'}）`,
                            )
                            .join('、')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {/* ── 4. 回填 ── */}
          <section className="card">
            <h2 className="section-title">4 · 回填</h2>
            <label className="mt-3 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={allowOverwrite}
                onChange={(e) => setAllowOverwrite(e.target.checked)}
              />
              <span>
                允许覆盖已有票号
                <span className="ml-1 text-xs text-ink-muted">
                  （库里已有<strong>不同</strong>的号时才用得上；覆盖后原来的号只在审计里查得到）
                </span>
              </span>
            </label>
            <div className="mt-3">
              <label className="label" htmlFor="ticket-note">
                备注（记进审计，选填）
              </label>
              <input
                id="ticket-note"
                className="input"
                maxLength={200}
                placeholder="例：照 9/5 QH9588 出票单回填"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn-primary text-sm"
                disabled={submitting || selection.pax === 0 || blockedByOverwrite}
                onClick={() => void handleSubmit()}
              >
                <Icon name="ticket" />{' '}
                {submitting
                  ? submitProgress
                    ? `回填中… 第 ${Math.min(submitProgress.done + 1, submitProgress.total)}/${submitProgress.total} 批`
                    : '回填中…'
                  : `回填 ${selection.pax} 人`}
              </button>
              {blockedByOverwrite && (
                <span className="text-xs text-amber-700">
                  勾选里有 {selection.overwrites} 条要覆盖已有票号，请先打开上方「允许覆盖已有票号」。
                </span>
              )}
              {selection.pax === 0 && !blockedByOverwrite && (
                <span className="text-xs text-ink-muted">请先勾选要回填的行。</span>
              )}
            </div>
            {submitError && <p className="mt-2 text-sm text-rose-700">{submitError}</p>}
          </section>
        </>
      )}

      {/* ── 5. 结果 ── */}
      {results && (
        <section className="card">
          <h2 className="section-title">回填结果</h2>
          <p className="mt-2 text-sm">
            成功 <span className="nums font-medium text-emerald-700">{okResults.length}</span> 条
            （其中真正写入 <span className="nums font-medium text-ink">{changedCount}</span> 条，
            <span className="nums">{unchangedCount}</span> 条本来就是这个号、没有改动）， 失败{' '}
            <span className="nums font-medium text-rose-700">{failedResults.length}</span> 条。
          </p>
          {failedResults.length > 0 && (
            <>
              <ul className="mt-2 space-y-1 text-xs">
                {failedResults.map((r) => (
                  <li key={`${r.orderId}:${r.passengerId}`} className="text-ink-soft">
                    <span className="font-mono">{r.orderNumber || r.orderId}</span>
                    {r.fullName ? ` · ${r.fullName}` : ''}
                    <span className="ml-2 text-rose-700">{r.error}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="btn-ghost mt-2 text-sm"
                disabled={submitting}
                onClick={() => void retryFailed()}
              >
                <Icon name="refresh" /> 重试失败项
              </button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
