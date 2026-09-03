/**
 * no-show 处理（批量）· ADMIN/STAFF
 *
 * 场景：航班起飞后航司给来一份未登机名单，票务贴进来一次性标完，顺带把回程座位放回库存。
 *
 * 口径与边界（都由服务端把关，本页只做勾选与展示）：
 *   - 能不能标（eligible / blockers）、要不要先拆单（scope）、能释放几座，全部以 preview 为准；
 *     前端不自己判，判出来的第二套口径必然漂移。
 *   - 未关柜的班次不给提交：柜台还开着，谁也说不准客人到底登不登机。关柜与否以 preview 的
 *     schedule.departed 为准（该字段算的是**关柜时刻** = 起飞时刻 − 关柜提前分钟数，
 *     默认提前 45 分钟；字段名沿用未改），本机时间只在选班次时给个提示。
 *   - 提交按 50 张单一片**顺序**连发（服务端 entries 上限就是 50，批量还是串行执行的）。
 *     每片一个 requestToken，按该片载荷指纹记忆化：「重试失败项」原样重发同一批载荷，
 *     已成功的片会被幂等回放、不会再执行一遍；改了勾选 / 释放开关 / 备注才换新键。
 *     单片失败不拦后面的片 —— 票务今天处理到哪就是哪，剩下的重试即可。
 *   - 「同时释放回程」是预检口径的一部分（回程已起飞能不能标要看它），开关一变就按新口径
 *     重新匹配一遍；提交前再兜一次底，开关与上次预检不一致时先重跑再让运营核对。
 *   - 护照只显示服务端下发的尾号。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type NoShowAmbiguousCandidate,
  type NoShowBatchPreview,
  type NoShowBatchResponse,
  type NoShowBatchResult,
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
  applyOrderAssessment,
  buildEntries,
  chunkEntries,
  defaultSelectedKeys,
  downgradedToSplitOrderIds,
  matchKey,
  newRequestToken,
  NO_SHOW_BATCH_CHUNK_SIZE,
  parseNameLines,
  payloadFingerprint,
  pinnedOrderIds,
  resolvePinnedAmbiguous,
  splitOrderNumbers,
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
  // 本机时间只作提示；真正的闸走 preview.schedule.departed（服务端按该班次自己的关柜分钟数算）。
  // 这里按系统默认 45 分钟粗估一下关柜时刻，让预检之前的角标不至于与预检后反着来。
  const DEFAULT_CHECKIN_CLOSE_MINUTES = 45;
  const looksDeparted = selectedSchedule
    ? new Date(selectedSchedule.departureTime).getTime() - DEFAULT_CHECKIN_CLOSE_MINUTES * 60_000 <
      Date.now()
    : false;

  // ── 名单与匹配 ────────────────────────────────────────────────────────
  const [namesText, setNamesText] = useState('');
  const [preview, setPreview] = useState<NoShowBatchPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // line → 选中的 passengerId，只用于多人同名面板的单选态展示
  const [ambiguousChoices, setAmbiguousChoices] = useState<Record<string, string>>({});
  // line → 钉住的 passengerId：重新预检后这一行如果还是撞了同名，就用它直接筛出那一位并入 matched
  const [pinnedPassengerIds, setPinnedPassengerIds] = useState<Record<string, string>>({});

  // 上一次预检用的「同时释放回程」口径：与当前开关不一致就说明这份匹配结果已经过期
  const [previewedReleaseReturn, setPreviewedReleaseReturn] = useState<boolean | null>(null);
  // 名单被服务端上限截断时，运营必须先确认「知道要分批」才放开提交
  const [truncationAcked, setTruncationAcked] = useState(false);
  // 预检轮次：补预检是异步的，回来时若已经有更新的一轮预检，旧结果一律丢弃
  const previewRunRef = useRef(0);

  // ── 提交 ──────────────────────────────────────────────────────────────
  const [releaseReturn, setReleaseReturn] = useState(true);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<NoShowBatchResponse | null>(null);
  // 分片进度（提交按钮上显示「第 2/5 批」），不提交时为 null
  const [submitProgress, setSubmitProgress] = useState<{ done: number; total: number } | null>(null);
  // 幂等键记忆：**按片**记 —— 同一片载荷（含重试）复用同一个 token，
  // 换了勾选/开关/备注的片自然指纹不同、换新键。
  const tokenMemo = useRef<Map<string, string>>(new Map());

  const nameLines = useMemo(() => parseNameLines(namesText), [namesText]);

  const resetMatch = useCallback(() => {
    setPreview(null);
    setSelectedKeys(new Set());
    setAmbiguousChoices({});
    setPinnedPassengerIds({});
    setPreviewedReleaseReturn(null);
    setTruncationAcked(false);
    setResult(null);
    setSubmitError(null);
    setSubmitProgress(null);
  }, []);

  // 换班次 = 换了一整批上下文，之前的匹配结果全部作废
  useEffect(() => {
    resetMatch();
  }, [scheduleId, resetMatch]);

  /**
   * 拿一份名单去服务端预检，再用当前钉住的候选把「仍然多人同名」的行就地解出来并入 matched。
   * 「匹配」按钮、多人同名面板选定候选、以及改「同时释放回程」开关，都走这一个函数。
   *
   * release 必须显式传：它是预检口径的一部分（回程已起飞时能不能标要看它），
   * 从 state 里读会拿到 setState 之前的旧值，预检与界面就对不上了。
   *
   * 钉住并入的行（pinned）没有真正过一遍服务端逐单判定，所以预检回来后再对**这些行所在的
   * 整张单**补一次 previewNoShow，把真实的 eligible/blockers/scope 盖回去；补不回来
   * （接口失败）就保留「未预检」警示，绝不假装判过。
   */
  const runPreview = useCallback(
    async (lines: string[], pins: Record<string, string>, release: boolean) => {
      if (!token || !scheduleId || lines.length === 0) return;
      const run = ++previewRunRef.current;
      setPreviewLoading(true);
      setPreviewError(null);
      setResult(null);
      setSubmitError(null);
      setSubmitProgress(null);
      setTruncationAcked(false);
      try {
        const res = await api.noShow.batchPreview(token, {
          scheduleId,
          names: lines.join('\n'),
          releaseReturn: release,
        });
        if (previewRunRef.current !== run) return;
        const { matched, ambiguous } = resolvePinnedAmbiguous(res.matched, res.ambiguous, pins);
        setPreview({ ...res, matched, ambiguous });
        setSelectedKeys(defaultSelectedKeys(matched));
        setPreviewedReleaseReturn(release);

        // 钉住并入的行：逐单补预检，拿真实口径
        const pendingOrderIds = pinnedOrderIds(matched);
        for (const orderId of pendingOrderIds) {
          const passengerIds = matched
            .filter((m) => m.orderId === orderId)
            .map((m) => m.passengerId);
          try {
            const single = await api.previewNoShow(token, orderId, {
              passengerIds,
              releaseReturn: release,
            });
            if (previewRunRef.current !== run) return;
            const patch = {
              eligible: single.eligible,
              blockers: single.blockers,
              scope: single.scope,
              alreadyNoShow: single.alreadyNoShow,
              hasReturn: single.returnItem != null,
              returnTicketed: single.returnItem?.ticketed ?? false,
              returnDeparted: single.returnDeparted,
            };
            setPreview((prev) =>
              prev ? { ...prev, matched: applyOrderAssessment(prev.matched, orderId, patch) } : prev,
            );
            // 补回来的口径可能把这张单判成不合格 / 需拆单 —— 勾选按新口径重来一遍
            setSelectedKeys((prev) => {
              const next = new Set(prev);
              for (const m of matched.filter((x) => x.orderId === orderId)) {
                const key = matchKey(m);
                if (!single.eligible || single.scope === 'SPLIT_REQUIRED' || single.alreadyNoShow) {
                  next.delete(key);
                }
              }
              return next;
            });
          } catch {
            // 这一张单补不回来：保留「未预检」警示，不改它的任何口径
          }
        }
      } catch (e) {
        if (previewRunRef.current !== run) return;
        setPreview(null);
        setSelectedKeys(new Set());
        setPreviewedReleaseReturn(null);
        setPreviewError(e instanceof ApiError ? e.message : '匹配失败，请稍后重试');
      } finally {
        if (previewRunRef.current === run) setPreviewLoading(false);
      }
    },
    [token, scheduleId],
  );

  const handleMatch = () => {
    if (nameLines.length === 0) return;
    void runPreview(nameLines, pinnedPassengerIds, releaseReturn);
  };

  /**
   * 改「同时释放回程」= 换了一套预检口径（回程已起飞的单在两档下结论不同），
   * 已经匹配过就立刻按新口径重跑一遍。重跑会把勾选恢复成默认值 —— 界面上明说了这一点。
   */
  const handleReleaseReturnChange = (checked: boolean) => {
    setReleaseReturn(checked);
    if (preview && nameLines.length > 0) {
      void runPreview(nameLines, pinnedPassengerIds, checked);
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

  /**
   * 多人同名面板选定某个候选：把该行文字换成候选的证件姓名、钉住这个选择，
   * 再自动重新预检一遍 —— 运营不用自己点「匹配」，选完就直接看到并入的结果。
   */
  const resolveAmbiguous = (line: string, candidate: NoShowAmbiguousCandidate) => {
    const replacement = candidate.fullName;
    const nextNamesText = namesText
      .split(/\r?\n/)
      .map((raw) => (raw.trim() === line ? replacement : raw))
      .join('\n');
    setNamesText(nextNamesText);
    setAmbiguousChoices((prev) => ({ ...prev, [line]: candidate.passengerId }));
    const nextPins = { ...pinnedPassengerIds, [replacement]: candidate.passengerId };
    setPinnedPassengerIds(nextPins);
    void runPreview(parseNameLines(nextNamesText), nextPins, releaseReturn);
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
  const chunks = useMemo(() => chunkEntries(entries), [entries]);
  // 本来整单、取消勾选后变成需拆单的单：表格上给琥珀提示
  const downgradedOrderIds = useMemo(
    () => (preview ? downgradedToSplitOrderIds(preview.matched, selectedKeys) : new Set<string>()),
    [preview, selectedKeys],
  );
  // 订单号索引：整片提交失败时用它把「哪几张单没动」如实列出来
  const orderNumberById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of preview?.matched ?? []) map.set(m.orderId, m.orderNumber);
    return map;
  }, [preview]);

  // 起飞与否：拿到 preview 后以服务端为准
  const departed = preview ? preview.schedule.departed : looksDeparted;
  // 名单被截断且运营还没确认「知道要分批」→ 先别让提交发生：
  // 以为整班都处理完了、其实后面几百人没看，是这个页面最贵的一种错。
  const truncationBlocked = Boolean(preview?.truncated) && !truncationAcked;
  // previewLoading 也拦：正在按新口径重新匹配时，界面上的勾选与合格判定还是上一轮的
  const canSubmit =
    Boolean(token) &&
    entries.length > 0 &&
    departed &&
    !submitting &&
    !previewLoading &&
    !truncationBlocked;

  /**
   * 按片顺序提交。
   *
   * 每片一个幂等键（按该片载荷指纹记忆化）：重试时同一片复用同一个键，服务端幂等回放，
   * 已成功的单不会被再执行一遍。整片请求失败（超时 / 网络断 / 400）只影响这一片 ——
   * 后面的片照跑，失败片里的每张单如实落一条失败结果，票务看得到是哪几张没动。
   */
  const runSubmit = useCallback(async () => {
    if (!token || !scheduleId || chunks.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitProgress({ done: 0, total: chunks.length });

    const merged: NoShowBatchResult[] = [];
    let ok = 0;
    let failed = 0;
    let releasedSeats = 0;
    // 幂等回放的单数：这些单在上一次提交里就已经处理过，本次没有再执行一遍
    // （服务端的 releasedSeats 也不把它们算进去，否则「重试失败项」会把座位数越加越多）。
    let replayedCount = 0;
    const chunkErrors: string[] = [];

    for (const [index, chunk] of chunks.entries()) {
      const fingerprint = payloadFingerprint({ scheduleId, entries: chunk, releaseReturn, note });
      let requestToken = tokenMemo.current.get(fingerprint);
      if (!requestToken) {
        requestToken = newRequestToken();
        tokenMemo.current.set(fingerprint, requestToken);
      }
      try {
        const res = await api.noShow.batch(token, {
          requestToken,
          scheduleId,
          entries: chunk,
          releaseReturn,
          note: note.trim() || undefined,
        });
        merged.push(...res.results);
        ok += res.summary.ok;
        failed += res.summary.failed;
        releasedSeats += res.summary.releasedSeats;
        // 旧后端不下发 replayedCount 时按逐单标记兜一次
        replayedCount +=
          res.summary.replayedCount ?? res.results.filter((r) => r.replayed).length;
      } catch (e) {
        const message = e instanceof ApiError ? e.message : '提交失败，请稍后重试';
        chunkErrors.push(`第 ${index + 1}/${chunks.length} 批（${chunk.length} 张单）：${message}`);
        for (const entry of chunk) {
          merged.push({
            orderId: entry.orderId,
            orderNumber: orderNumberById.get(entry.orderId) ?? entry.orderId,
            ok: false,
            replayed: false,
            error: message,
          });
        }
        failed += chunk.length;
      }
      // 每片一落：批次多的时候运营能看着结果一片片长出来，不用干等
      setResult({ results: [...merged], summary: { ok, failed, releasedSeats, replayedCount } });
      setSubmitProgress({ done: index + 1, total: chunks.length });
    }

    setSubmitError(chunkErrors.length > 0 ? chunkErrors.join('\n') : null);
    setSubmitting(false);
    setSubmitProgress(null);
  }, [token, scheduleId, chunks, releaseReturn, note, orderNumberById]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    // 兜底：开关改了但那次重跑没成功（网络失败等）时，界面上的合格判定已经不是当前口径了 ——
    // 先按当前开关重跑一遍，让运营看过新结果再提交。
    if (previewedReleaseReturn !== null && previewedReleaseReturn !== releaseReturn) {
      await runPreview(nameLines, pinnedPassengerIds, releaseReturn);
      setSubmitError('「同时释放回程」改过了，已按新口径重新匹配一遍，请核对勾选后再提交。');
      return;
    }
    const splitNumbers = splitOrderNumbers(selectedMatches);
    // 拆单不可回滚：会被拆的单号逐条列出来（多了只列前 20 张，剩下的给个数）
    const splitList =
      splitNumbers.length > 0
        ? `\n\n会先自动拆单的 ${splitNumbers.length} 张单（拆出的新单承接这些人的钱与座位，不可回滚）：\n${splitNumbers
            .slice(0, 20)
            .join('、')}${splitNumbers.length > 20 ? ` 等 ${splitNumbers.length} 张` : ''}`
        : '';
    const chunkNote =
      chunks.length > 1
        ? `\n\n本次分 ${chunks.length} 批发送（每批最多 ${NO_SHOW_BATCH_CHUNK_SIZE} 张单），中途失败的批不影响其它批，可用「重试失败项」重来。`
        : '';
    const ok = await confirm({
      title: '确认标记 no-show？',
      tone: 'danger',
      confirmText: '确认标记',
      body: `本次将标记 ${summary.pax} 人 / ${summary.orders} 张单${
        summary.splitOrders > 0 ? `，其中 ${summary.splitOrders} 张会先自动拆单` : ''
      }。${splitList}\n\n${
        releaseReturn
          ? `同时释放回程座位（预计 ${summary.estimatedReleasedSeats} 座回到库存重新可卖）。已出票的回程会开出撤名单 / 退票工单。`
          : '不释放回程座位：回程仍然占着库存。'
      }${chunkNote}\n\n去程钱不动。标错了只能逐单人工恢复，提交前请再核一遍名单。`,
    });
    if (!ok) return;
    await runSubmit();
  };

  const failedResults = result?.results.filter((r) => !r.ok) ?? [];
  // 服务端按订单张数截断时用来说清「只预检了前几单」：优先用服务端下发的 processedOrders，
  // 旧后端没有这一项时回落成命中的去重单数。
  const matchedOrderCount = useMemo(
    () => new Set((preview?.matched ?? []).map((m) => m.orderId)).size,
    [preview],
  );
  const previewedOrderCount = preview?.processedOrders ?? matchedOrderCount;
  const totalOrderCount = preview?.totalOrders ?? matchedOrderCount;

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
                <span className="badge-neutral" title="值机柜台已关闭（起飞前 45 分钟关柜，个别班次可单独配置）">
                  已关柜
                </span>
              ) : (
                <span className="badge-warning" title="值机柜台还开着，客人仍可能赶上">
                  未关柜
                </span>
              )}
            </div>
            {!departed && (
              <p className="mt-1.5 text-xs text-amber-700">
                <Icon name="alert" /> 本班次还没关柜，不能标 no-show —— 柜台还开着，谁也说不准客人到底登不登机。
                可以先贴名单做匹配核对，关柜后再回来提交。
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
            onClick={handleMatch}
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
          {/* 名单被服务端上限截断：必须明说，否则票务以为整班都处理完了 */}
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
                行这次<strong>没有</strong>参与匹配，也不会被标记。先把这一批处理完，再把剩下的名单贴进来匹配一次。
              </p>
              <label className="mt-2 flex items-center gap-2 text-sm text-rose-800">
                <input
                  type="checkbox"
                  checked={truncationAcked}
                  onChange={(e) => setTruncationAcked(e.target.checked)}
                />
                我知道这次只处理前 {preview.processedLines} 行，剩下的会另外分批处理
              </label>
            </section>
          )}

          {/* 按订单张数截断（与按行截断是两把不同的刀）：名单行都看了，但命中的单太多，
              服务端只预检了前面这些单 —— 同样必须明说，否则以为整班都处理完了。 */}
          {preview.truncatedOrders && (
            <section className="card border-rose-300 bg-rose-50/70">
              <p className="text-sm font-semibold text-rose-700">
                本次名单涉及 <span className="nums">{totalOrderCount}</span> 张单，超过单次上限，只预检了前{' '}
                <span className="nums">{previewedOrderCount}</span> 单，请分批。
              </p>
              <p className="mt-1 text-xs text-rose-700">
                没进这批的单在下方会带「这一单没有预检」的拦截原因，勾不了也不会被标记。先把这一批处理完，
                再把剩下的名单贴进来匹配一次。
              </p>
            </section>
          )}

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
              downgradedOrderIds={downgradedOrderIds}
              onToggle={toggleKey}
              onToggleAll={toggleAll}
            />
          </section>

          <NoShowUnresolvedPanels
            unmatched={preview.unmatched}
            ambiguous={preview.ambiguous}
            choices={ambiguousChoices}
            onChoose={resolveAmbiguous}
            disabled={previewLoading}
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
                  disabled={previewLoading}
                  onChange={(e) => handleReleaseReturnChange(e.target.checked)}
                />
                <span className="text-sm">
                  <span className="font-medium text-ink">同时释放回程座位</span>
                  <span className="mt-0.5 block text-xs text-ink-muted">
                    把回程座位放回库存重新可卖（钱不动）。已出票的回程会开出撤名单 / 退票工单；
                    代理事后来要，运营仍可逐单恢复。
                  </span>
                  <span className="mt-0.5 block text-xs text-amber-700">
                    改这个开关会按新口径重新匹配一遍（回程已起飞的单在两档下结论不同），勾选会恢复默认。
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

            {chunks.length > 1 && (
              <p className="mt-2 text-xs text-ink-muted">
                共 <span className="nums">{chunks.length}</span> 批发送（每批最多{' '}
                <span className="nums">{NO_SHOW_BATCH_CHUNK_SIZE}</span> 张单）：按批顺序执行，
                某一批失败不影响其它批。
              </p>
            )}

            {submitError && (
              <p className="mt-2 whitespace-pre-line text-sm text-rose-700">{submitError}</p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn-danger text-sm"
                disabled={!canSubmit}
                onClick={() => void handleSubmit()}
              >
                {submitting
                  ? submitProgress && submitProgress.total > 1
                    ? `提交中… 第 ${Math.min(submitProgress.done + 1, submitProgress.total)}/${submitProgress.total} 批`
                    : '提交中…'
                  : '标记 no-show'}
              </button>
              {!departed && <span className="text-xs text-amber-700">班次未关柜，暂不能提交</span>}
              {departed && truncationBlocked && (
                <span className="text-xs text-rose-700">
                  名单被截断，请先确认上方「知道要分批」再提交
                </span>
              )}
              {departed && !truncationBlocked && entries.length === 0 && (
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
              {(result.summary.replayedCount ?? 0) > 0 && (
                <span
                  className="ml-2 text-xs font-normal text-ink-muted"
                  title="这些单在上一次提交里就已经处理过，本次幂等回放、没有再执行一遍；释放座位数也不重复计入"
                >
                  （其中 {result.summary.replayedCount ?? 0} 张为已处理过的回放）
                </span>
              )}
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
                  <th className="whitespace-nowrap text-left">订单号</th>
                  <th className="whitespace-nowrap text-left">结果</th>
                  <th
                    className="whitespace-nowrap text-left"
                    title="只标了本单部分乘客时服务端会先拆出一张新单，这一列是新单号；整单处理没有新单，显示 —"
                  >
                    拆出的新单
                  </th>
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
                      {!r.ok ? (
                        <span className="badge-danger">失败</span>
                      ) : r.replayed ? (
                        // 回放行：这一单上次就处理完了，本次什么都没做 —— 说成「本次释放 N 座」
                        // 会让人以为又放了一批座位出去。
                        <span
                          className="badge-info"
                          title="上一次提交里已经处理过，本次幂等回放，没有再执行一遍"
                        >
                          已处理过（回放）
                        </span>
                      ) : (
                        <span className="badge-success">已标记</span>
                      )}
                    </td>
                    {/* 服务端整单处理时 targetOrderNumber 就是原单号 —— 那不是「拆出的新单」，
                        照抄一遍会让运营以为拆过。只有真拆出新单（单号不同）才显示。 */}
                    <td className="nums">
                      {r.targetOrderNumber && r.targetOrderNumber !== r.orderNumber
                        ? r.targetOrderNumber
                        : '—'}
                    </td>
                    <td className="nums text-right">
                      {r.replayed ? (
                        <span className="text-ink-muted" title="回放行不重复计释放座位">
                          —
                        </span>
                      ) : (
                        (r.releasedSeats ?? 0)
                      )}
                    </td>
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
