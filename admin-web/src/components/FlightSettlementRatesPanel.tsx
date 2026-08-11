/**
 * 机票结算价日历（ADMIN/STAFF）— 运营的机票报价表进系统：行 = 起始日期起 31 天，列 = 在用航班号
 * （去程/回程各一列），每格一个每人 OTA 结算价（CNY）。
 *
 * 数据源：backend/src/modules/settlement-rates/flight-settlement-rates.*
 *   GET    /flight-settlement-rates?from&to&flightNumbers   区间网格查询
 *   PUT    /flight-settlement-rates/batch                   批量 upsert（整批保存 / Excel 粘贴块）
 *   DELETE /flight-settlement-rates/:id                     删除一格
 *
 * 口径：代理下**纯机票单**时，服务端按每条航段的航班号 + 出发地本地日在此表自动取每人价，
 * 全部航段都命中才自动收敛订单总额；任一航段没维护则照常走动态定价（代理改不了这个价）。
 *
 * 两种粘贴并存：
 *   1. 网格逐格粘贴——选中起始格 Ctrl/⌘+V 铺开填草稿，再「整批保存」；
 *   2.「📋 粘贴报价表」——整块粘贴运营 OTA 报价表原文，由 lib/quoteSheetParser 解析出
 *      （出发日 × 航班号）后预览确认，直接走批量 upsert 写库并重拉网格。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type AdminFlight,
  type FlightSettlementRate,
  type FlightSettlementRateWriteEntry,
} from '../lib/api';
import {
  WEEKDAYS,
  WINDOW_DAYS,
  addDays,
  parsePasteBlock,
  todayYmd,
  windowDays,
  weekdayOf,
} from '../lib/settlementCalendar';
import {
  parseOtaQuoteSheet,
  type OtaQuoteEntry,
  type QuoteSheetResult,
} from '../lib/quoteSheetParser';
import { useAuth } from '../stores/auth';

// 报价表导入分批大小（批量端点单次上限 2000 条）
const IMPORT_BATCH_SIZE = 500;

function cellKey(date: string, flightNumber: string): string {
  return `${date}__${flightNumber}`;
}

export function FlightSettlementRatesPanel() {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';

  const [windowStart, setWindowStart] = useState<string>(() => todayYmd());
  const [flights, setFlights] = useState<AdminFlight[]>([]);
  const [rates, setRates] = useState<FlightSettlementRate[]>([]);
  // 编辑草稿：cellKey → 输入框字符串（空串 = 清空该格）。整批保存时与已加载 rates 对比出增删改。
  const [draft, setDraft] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pasteWarning, setPasteWarning] = useState<string | null>(null);
  // 报价表整块粘贴导入（与网格逐格粘贴并存：这里一次吃整张 OTA 表，直接写库）
  const [sheetText, setSheetText] = useState('');
  const [sheetParsed, setSheetParsed] = useState<QuoteSheetResult<OtaQuoteEntry> | null>(null);
  const [importing, setImporting] = useState(false);
  const [nonce, setNonce] = useState(0);

  const today = todayYmd();
  const previousWindowStart = addDays(windowStart, -WINDOW_DAYS);
  const days = useMemo(() => windowDays(windowStart, WINDOW_DAYS), [windowStart]);

  // 列 = 在用航班号（去程/回程都列，按航班号排序，顺序稳定便于对着报价表粘贴）
  const flightNumbers = useMemo(
    () =>
      flights
        .filter((f) => f.isActive)
        .map((f) => f.flightNumber)
        .sort((a, b) => a.localeCompare(b)),
    [flights],
  );

  // 航班号 → 航线（列头副标题，让运营一眼看出哪列是去程/回程）
  const routeOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of flights) map.set(f.flightNumber, `${f.originCode}→${f.destinationCode}`);
    return map;
  }, [flights]);

  const rateByKey = useMemo(() => {
    const map = new Map<string, FlightSettlementRate>();
    for (const r of rates) map.set(cellKey(r.departDate, r.flightNumber), r);
    return map;
  }, [rates]);

  // 最近更新时间（updatedBy 是 userId，只展示时间避免误露内部账号）
  const lastUpdated = useMemo(() => {
    if (rates.length === 0) return null;
    return rates.reduce((max, r) => (r.updatedAt > max ? r.updatedAt : max), rates[0].updatedAt);
  }, [rates]);

  useEffect(() => {
    if (!token) return;
    api
      .listAllFlights(token)
      .then((r) => setFlights(r.flights))
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : '航班列表加载失败'));
  }, [token]);

  const load = useCallback(async () => {
    if (!token || days.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      // 不传 flightNumbers：一次拉取当前显示范围内全部航班号的价（含已停用航班的历史价，不至于静默丢数据）
      const res = await api.listFlightSettlementRates(token, {
        from: days[0],
        to: days[days.length - 1],
      });
      setRates(res.rates);
      const next = new Map<string, string>();
      for (const r of res.rates) {
        next.set(cellKey(r.departDate, r.flightNumber), String(r.pricePerPersonCny));
      }
      setDraft(next);
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : '机票结算价加载失败');
    } finally {
      setLoading(false);
    }
  }, [token, days]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, windowStart, nonce]);

  function setCell(date: string, flightNumber: string, value: string) {
    setDraft((prev) => {
      const next = new Map(prev);
      next.set(cellKey(date, flightNumber), value);
      return next;
    });
  }

  /**
   * Excel 块状粘贴：从命中的格子（startDay × startFlight）向右下铺开填充。
   * 行按换行、列按 tab 拆分——对应运营报价表「一个日期分几个航班」的列结构。
   * 超出网格范围（行超出显示范围 / 列超出航班数）的部分静默丢弃，但提示丢了多少格。
   */
  function handlePaste(
    e: React.ClipboardEvent<HTMLInputElement>,
    startDayIdx: number,
    startFlightIdx: number,
  ) {
    const block = parsePasteBlock(e.clipboardData.getData('text'));
    if (!block) return; // 单值 → 默认行为
    e.preventDefault();
    const updates: Array<[string, string]> = [];
    let overflow = 0;
    block.forEach((row, r) => {
      row.forEach((value, c) => {
        const dayIdx = startDayIdx + r;
        const flightIdx = startFlightIdx + c;
        if (dayIdx >= days.length || flightIdx >= flightNumbers.length) {
          overflow += 1;
          return;
        }
        updates.push([cellKey(days[dayIdx], flightNumbers[flightIdx]), value]);
      });
    });
    setDraft((prev) => {
      const next = new Map(prev);
      for (const [key, value] of updates) next.set(key, value);
      return next;
    });
    setPasteWarning(overflow > 0 ? `粘贴溢出 ${overflow} 格已忽略（超出显示范围（31 天）或航班列数）` : null);
  }

  async function save() {
    if (!token) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const upserts: FlightSettlementRateWriteEntry[] = [];
      const deletes: string[] = [];
      for (const date of days) {
        for (const flightNumber of flightNumbers) {
          const key = cellKey(date, flightNumber);
          const trimmed = (draft.get(key) ?? '').trim();
          const existing = rateByKey.get(key);
          if (trimmed === '') {
            if (existing) deletes.push(existing.id); // 清空已存在的格 → 删除
            continue;
          }
          const v = Number(trimmed);
          if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
            throw new Error(`${date} ${flightNumber} 的价格「${trimmed}」不是有效整数`);
          }
          // 仅提交新增/改动的格（幂等 upsert 也可，但少发无谓写）
          if (!existing || existing.pricePerPersonCny !== v) {
            upserts.push({ flightNumber, departDate: date, pricePerPersonCny: v });
          }
        }
      }
      if (upserts.length === 0 && deletes.length === 0) {
        setNotice('没有改动');
        setSaving(false);
        return;
      }
      if (upserts.length > 0) await api.upsertFlightSettlementRates(token, upserts);
      for (const id of deletes) await api.deleteFlightSettlementRate(token, id);
      setNotice(`已保存：更新 ${upserts.length} 格，删除 ${deletes.length} 格`);
      setNonce((n) => n + 1);
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  /** 报价表整块粘贴 → 解析预览（纯前端，不写库；运营核对无误再点导入）。 */
  function previewQuoteSheet() {
    setSheetParsed(parseOtaQuoteSheet(sheetText, windowStart.slice(0, 7)));
  }

  /** 确认导入：解析出的条目直接走既有批量 upsert，完事重拉网格。 */
  async function importQuoteSheet() {
    if (!token || !sheetParsed || sheetParsed.entries.length === 0) return;
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const entries = sheetParsed.entries;
      for (let i = 0; i < entries.length; i += IMPORT_BATCH_SIZE) {
        await api.upsertFlightSettlementRates(token, entries.slice(i, i + IMPORT_BATCH_SIZE));
      }
      setNotice(`报价表已导入 ${entries.length} 格机票结算价`);
      setSheetParsed(null);
      setSheetText('');
      setNonce((n) => n + 1);
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : '报价表导入失败');
    } finally {
      setImporting(false);
    }
  }

  const dirty = useMemo(() => {
    for (const date of days) {
      for (const flightNumber of flightNumbers) {
        const key = cellKey(date, flightNumber);
        const trimmed = (draft.get(key) ?? '').trim();
        const existing = rateByKey.get(key);
        if (trimmed === '' && existing) return true;
        if (trimmed !== '' && (!existing || String(existing.pricePerPersonCny) !== trimmed)) {
          return true;
        }
      }
    }
    return false;
  }, [draft, days, flightNumbers, rateByKey]);

  // 解析结果里当前网格看不到的部分（照样入库，但要提示运营去哪儿核对）
  const sheetOutsideGrid = useMemo(() => {
    if (!sheetParsed) return { past: 0, outside: 0, unknownFlights: [] as string[] };
    const known = new Set(flightNumbers);
    const daySet = new Set(days);
    const dateCounts = sheetParsed.entries.reduce(
      (counts, entry) => {
        if (entry.departDate < today) counts.past += 1;
        else if (!daySet.has(entry.departDate)) counts.outside += 1;
        return counts;
      },
      { past: 0, outside: 0 },
    );
    return {
      ...dateCounts,
      unknownFlights: [
        ...new Set(
          sheetParsed.entries.map((e) => e.flightNumber).filter((fn) => !known.has(fn)),
        ),
      ],
    };
  }, [days, sheetParsed, flightNumbers, today]);

  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="label">起始日期</label>
          <input
            type="date"
            className="input"
            min={today}
            value={windowStart}
            disabled={dirty}
            onChange={(e) => {
              const next = e.target.value;
              if (!next) return;
              setWindowStart(next < today ? today : next);
            }}
          />
          {dirty && <p className="mt-1 text-[11px] text-amber-700">有未保存改动，请先整批保存</p>}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="btn-secondary"
            disabled={dirty || windowStart === today}
            onClick={() => setWindowStart(today)}
          >
            今天
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={dirty || windowStart === today}
            onClick={() => setWindowStart(previousWindowStart === '' || previousWindowStart < today ? today : previousWindowStart)}
          >
            ◀ 前 31 天
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={dirty}
            onClick={() => setWindowStart(addDays(windowStart, WINDOW_DAYS))}
          >
            后 31 天 ▶
          </button>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {lastUpdated && (
            <span className="text-[11px] text-ink-muted">
              最近更新：{new Date(lastUpdated).toLocaleString('zh-CN')}
            </span>
          )}
          <button
            type="button"
            className="btn-primary"
            disabled={saving || !dirty}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '整批保存'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 ring-1 ring-emerald-200">
          {notice}
        </div>
      )}
      {pasteWarning && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700 ring-1 ring-amber-200">
          {pasteWarning}
        </div>
      )}
      {/* 报价表整块粘贴导入：一次吃整张 OTA 表（左右两张并排表都认），与下方逐格粘贴并存 */}
      <details className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2">
        <summary className="cursor-pointer text-sm font-semibold text-ink">
          📋 粘贴报价表（整块导入 OTA 结算价）
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-[11px] text-ink-muted">
            从报价表 Excel 里整块复制（含表头也没关系），直接粘贴到下框 →「解析预览」核对 →「确认导入」。
            左右两张并排表都认，只复制半张也行；价取「OTA结算」列（不取「易达」列），
            「售罄」「765余7」这类带备注的格不入库，会列在跳过明细里让运营手工确认。
          </p>
          <textarea
            className="input h-40 w-full font-mono text-xs"
            placeholder="在这里粘贴报价表内容（日期 / 星期 / 航段 / 航班号 / OTA结算…）"
            value={sheetText}
            onChange={(e) => {
              setSheetText(e.target.value);
              setSheetParsed(null); // 文本一改，旧预览作废，必须重新解析后才能导入
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={sheetText.trim() === ''}
              onClick={previewQuoteSheet}
            >
              解析预览
            </button>
            {sheetParsed && sheetParsed.entries.length > 0 && (
              <button
                type="button"
                className="btn-primary"
                disabled={importing || dirty}
                onClick={() => void importQuoteSheet()}
              >
                {importing ? '导入中…' : `确认导入 ${sheetParsed.entries.length} 条`}
              </button>
            )}
            {sheetParsed && sheetParsed.entries.length > 0 && dirty && (
              <span className="text-[11px] text-amber-700">
                网格里有未保存的手工改动，请先「整批保存」再导入（导入后会重拉网格）
              </span>
            )}
          </div>

          {sheetParsed && (
            <div className="space-y-2">
              <div className="text-xs text-ink">
                解析出 <b className="tabular-nums">{sheetParsed.entries.length}</b> 条价格，跳过{' '}
                <b className="tabular-nums">{sheetParsed.skipped.length}</b> 行
                {sheetOutsideGrid.past > 0 &&
                  `；其中 ${sheetOutsideGrid.past} 条为过去日期，已入库但日历不再展示`}
                {sheetOutsideGrid.outside > 0 &&
                  `；${sheetOutsideGrid.past > 0 ? '另有' : '其中'} ${sheetOutsideGrid.outside} 条不在当前显示范围，导入后请调整起始日期查看`}
              </div>

              {sheetOutsideGrid.unknownFlights.length > 0 && (
                <div className="rounded-md bg-amber-50 px-3 py-2 text-[11px] text-amber-800 ring-1 ring-amber-200">
                  报价表里的 {sheetOutsideGrid.unknownFlights.join('、')} 不在当前在用航班列里，
                  价照样入库，但网格上没有这一列——需要的话先去「航班」页建档/启用。
                </div>
              )}

              {sheetParsed.entries.length === 0 && sheetParsed.skipped.length === 0 && (
                <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
                  没认出任何价格。请确认复制的是报价表整块内容（要带日期、航班号和「OTA结算」列）。
                </div>
              )}

              {sheetParsed.entries.length > 0 && (
                <div className="max-h-64 overflow-auto rounded-md border border-slate-200 bg-white">
                  <table className="min-w-full text-xs">
                    <thead className="sticky top-0 bg-slate-50 text-left text-ink-muted">
                      <tr>
                        <th className="px-3 py-1.5 font-medium">出发日期</th>
                        <th className="px-3 py-1.5 font-medium">航班号</th>
                        <th className="px-3 py-1.5 text-right font-medium">每人结算价</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sheetParsed.entries.map((e) => (
                        <tr
                          key={`${e.departDate}-${e.flightNumber}`}
                          className="border-t border-slate-100"
                        >
                          <td className="px-3 py-1 tabular-nums">{e.departDate}</td>
                          <td className="px-3 py-1 tabular-nums">{e.flightNumber}</td>
                          <td className="px-3 py-1 text-right tabular-nums">
                            {e.pricePerPersonCny}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {sheetParsed.skipped.length > 0 && (
                <div className="max-h-40 overflow-auto rounded-md bg-amber-50 px-3 py-2 text-[11px] text-amber-800 ring-1 ring-amber-200">
                  <div className="font-semibold">
                    以下 {sheetParsed.skipped.length} 行没入库，可回报价表核对：
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {sheetParsed.skipped.map((s, i) => (
                      <li key={`${s.line}-${i}`}>
                        第 {s.line} 行：{s.reason}
                        {s.raw !== '' && `（${s.raw}）`}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </details>

      <p className="text-[11px] text-ink-muted">
        提示：行 = 起始日期起 31 天，列 = 在用航班号（去程 / 回程各一列）。可从 Excel 复制一块「日期 ×
        航班」区域，选中起始格后直接粘贴（Ctrl/⌘+V）批量填充；清空格子并保存即删除该价。
        代理下纯机票单时按各航段的航班号 + 出发日在此表自动取每人价（全部航段都有价才自动取，代理改不了）。
      </p>

      {loading ? (
        <div className="py-10 text-center text-sm text-ink-muted">加载中…</div>
      ) : flightNumbers.length === 0 ? (
        <div className="py-10 text-center text-sm text-ink-muted">
          暂无在用航班，请先在「航班」页建档后再维护结算价。
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-ink-muted">
                <th className="sticky left-0 z-10 bg-white px-3 py-2 font-medium">出发日期</th>
                {flightNumbers.map((fn) => (
                  <th key={fn} className="px-3 py-2 text-center font-medium">
                    <div className="tabular-nums">{fn}</div>
                    <div className="text-[10px] font-normal text-ink-muted">
                      {routeOf.get(fn) ?? ''}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((date, dayIdx) => {
                const wd = weekdayOf(date);
                const weekend = wd === 0 || wd === 6;
                return (
                  <tr key={date} className="border-b border-slate-100">
                    <td
                      className={`sticky left-0 z-10 bg-white px-3 py-1.5 whitespace-nowrap tabular-nums ${
                        weekend ? 'text-rose-600' : 'text-ink'
                      }`}
                    >
                      {date.slice(5)} 周{WEEKDAYS[wd]}
                    </td>
                    {flightNumbers.map((fn, flightIdx) => {
                      const key = cellKey(date, fn);
                      const existing = rateByKey.get(key);
                      return (
                        <td key={fn} className="px-1 py-1">
                          <input
                            inputMode="numeric"
                            className="input w-full text-right tabular-nums"
                            placeholder="—"
                            value={draft.get(key) ?? ''}
                            title={
                              existing
                                ? `最近更新：${new Date(existing.updatedAt).toLocaleString('zh-CN')}`
                                : undefined
                            }
                            onChange={(e) => setCell(date, fn, e.target.value)}
                            onPaste={(e) => handlePaste(e, dayIdx, flightIdx)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
