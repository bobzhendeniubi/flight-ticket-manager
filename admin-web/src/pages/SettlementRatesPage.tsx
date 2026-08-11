/**
 * 结算价日历 · ADMIN/STAFF — 运营维护「出发日期 × 晚数 × 酒店档次」的每人同业结算价（代理不可见）
 *
 * 数据源：backend/src/modules/settlement-rates/*
 *   GET    /settlement-rates?from&to&tier     网格查询（缺省 nights = 返回区间内全部晚数）
 *   PUT    /settlement-rates/batch            批量 upsert（整批保存 / Excel 粘贴块）
 *   DELETE /settlement-rates/:id              删除一格
 *
 * 口径：选「起始日期 + 档次」→ 网格（行 = 起始日期起 31 天，列 = 晚数 1–5）。格子直接编辑、整批保存；
 * 支持从 Excel 复制块状粘贴（tab/换行解析，与运营报价表「一个日期分几晚」逐列对应）；
 * 代理下套餐单时按去程出发日期 + 晚数 + 档次在此表自动取每人价。
 *
 * 两种粘贴并存：
 *   1. 网格逐格粘贴——选中起始格 Ctrl/⌘+V，按当前档次铺开填草稿，再「整批保存」；
 *   2.「📋 粘贴报价表」——整块粘贴运营报价表原文，由 lib/quoteSheetParser 解析出
 *      （出发日 × 晚数 × 四个档次）后预览确认，直接走批量 upsert 写库并重拉网格。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type SettlementRate,
  type SettlementRateWriteEntry,
  type SettlementTier,
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
  parseGroundQuoteSheet,
  type GroundQuoteEntry,
  type QuoteSheetResult,
} from '../lib/quoteSheetParser';
import { FlightSettlementRatesPanel } from '../components/FlightSettlementRatesPanel';
import { useAuth } from '../stores/auth';

// 页签：地面整包价（档次 × 晚数）/ 机票结算价（航班号 × 出发日）——两张表各管各的
type RateTab = 'GROUND' | 'FLIGHT';

// 四档（顶部筛选按钮顺序固定）+ 中文标签（后端只存枚举值）
const TIERS: SettlementTier[] = ['CITY_3STAR', 'CITY_4STAR', 'CITY_5STAR', 'INTL_5STAR'];
const TIER_LABELS: Record<SettlementTier, string> = {
  CITY_3STAR: '市区三星',
  CITY_4STAR: '市区四星',
  CITY_5STAR: '市区五星',
  INTL_5STAR: '国际五星',
};
// 晚数（网格列顺序固定，1–5 晚——同业结算表当前只维护到 5 晚）
const NIGHTS_OPTIONS = [1, 2, 3, 4, 5];
// 报价表导入分批大小（批量端点单次上限 2000 条）
const IMPORT_BATCH_SIZE = 500;

function cellKey(date: string, nights: number): string {
  return `${date}__${nights}`;
}

export function SettlementRatesPage() {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';

  const [tab, setTab] = useState<RateTab>('GROUND');
  const [windowStart, setWindowStart] = useState<string>(() => todayYmd());
  const [tier, setTier] = useState<SettlementTier>(TIERS[0]);
  const [rates, setRates] = useState<SettlementRate[]>([]);
  // 编辑草稿：cellKey → 输入框字符串（空串 = 清空该格）。整批保存时与已加载 rates 对比出增删改。
  const [draft, setDraft] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pasteWarning, setPasteWarning] = useState<string | null>(null);
  // 报价表整块粘贴导入（与网格逐格粘贴并存：这里一次吃整张表，直接写库）
  const [sheetText, setSheetText] = useState('');
  const [sheetParsed, setSheetParsed] = useState<QuoteSheetResult<GroundQuoteEntry> | null>(null);
  const [importing, setImporting] = useState(false);
  // 数据变更后 +1 触发重拉
  const [nonce, setNonce] = useState(0);

  const today = todayYmd();
  const previousWindowStart = addDays(windowStart, -WINDOW_DAYS);
  const days = useMemo(() => windowDays(windowStart, WINDOW_DAYS), [windowStart]);

  // 已加载 rates 按格键索引（对比增删改 + 单格 tooltip 展示「何时改的」）
  const rateByKey = useMemo(() => {
    const map = new Map<string, SettlementRate>();
    for (const r of rates) map.set(cellKey(r.departDate, r.nights), r);
    return map;
  }, [rates]);

  // 最近更新时间（展示用；updatedBy 是 userId，此处只展示时间避免误露内部账号）
  const lastUpdated = useMemo(() => {
    if (rates.length === 0) return null;
    return rates.reduce((max, r) => (r.updatedAt > max ? r.updatedAt : max), rates[0].updatedAt);
  }, [rates]);

  const load = useCallback(async () => {
    if (!token || days.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const from = days[0];
      const to = days[days.length - 1];
      // 不传 nights：一次拉取当前显示范围内该档次下全部晚数（1–5 晚全列齐）
      const res = await api.listSettlementRates(token, { from, to, tier });
      setRates(res.rates);
      const next = new Map<string, string>();
      for (const r of res.rates) next.set(cellKey(r.departDate, r.nights), String(r.pricePerPersonCny));
      setDraft(next);
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : '结算价加载失败');
    } finally {
      setLoading(false);
    }
  }, [token, days, tier]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, windowStart, tier, nonce]);

  function setCell(date: string, nights: number, value: string) {
    setDraft((prev) => {
      const next = new Map(prev);
      next.set(cellKey(date, nights), value);
      return next;
    });
  }

  /**
   * Excel 块状粘贴：从命中的格子（startDay × startNights）向右下铺开填充。
   * 行按换行、列按 tab 拆分——对应运营报价表「一个日期分几晚」的列结构。
   * 命中多格时接管默认粘贴（preventDefault），单值粘贴走浏览器默认；
   * 粘贴区域超出网格范围（行超出显示范围 / 列超出 5 晚）时该部分静默丢弃，但会提示丢弃了多少格。
   */
  function handlePaste(
    e: React.ClipboardEvent<HTMLInputElement>,
    startDayIdx: number,
    startNightIdx: number,
  ) {
    const block = parsePasteBlock(e.clipboardData.getData('text'));
    if (!block) return; // 单值 → 默认行为
    e.preventDefault();
    const updates: Array<[string, string]> = [];
    let overflow = 0;
    block.forEach((row, r) => {
      row.forEach((value, c) => {
        const dayIdx = startDayIdx + r;
        const nightIdx = startNightIdx + c;
        if (dayIdx >= days.length || nightIdx >= NIGHTS_OPTIONS.length) {
          overflow += 1;
          return;
        }
        updates.push([cellKey(days[dayIdx], NIGHTS_OPTIONS[nightIdx]), value]);
      });
    });
    setDraft((prev) => {
      const next = new Map(prev);
      for (const [key, value] of updates) next.set(key, value);
      return next;
    });
    setPasteWarning(overflow > 0 ? `粘贴溢出 ${overflow} 格已忽略（超出显示范围（31 天）或超过 5 晚）` : null);
  }

  async function save() {
    if (!token) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const upserts: SettlementRateWriteEntry[] = [];
      const deletes: string[] = [];
      for (const date of days) {
        for (const nights of NIGHTS_OPTIONS) {
          const key = cellKey(date, nights);
          const trimmed = (draft.get(key) ?? '').trim();
          const existing = rateByKey.get(key);
          if (trimmed === '') {
            if (existing) deletes.push(existing.id); // 清空已存在的格 → 删除
            continue;
          }
          const v = Number(trimmed);
          if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
            throw new Error(`${date} ${nights}晚 的价格「${trimmed}」不是有效整数`);
          }
          // 仅提交新增/改动的格（幂等 upsert 也可，但少发无谓写）
          if (!existing || existing.pricePerPersonCny !== v) {
            upserts.push({ tier, nights, departDate: date, pricePerPersonCny: v });
          }
        }
      }
      if (upserts.length === 0 && deletes.length === 0) {
        setNotice('没有改动');
        setSaving(false);
        return;
      }
      if (upserts.length > 0) await api.upsertSettlementRates(token, upserts);
      for (const id of deletes) await api.deleteSettlementRate(token, id);
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
    setSheetParsed(parseGroundQuoteSheet(sheetText, windowStart.slice(0, 7)));
  }

  /**
   * 确认导入：解析出的条目直接走既有批量 upsert（一条一格，含四个档次），完事重拉网格。
   * 只写解析到的格，报价表里是「/」或空的档次不动既有值。
   */
  async function importQuoteSheet() {
    if (!token || !sheetParsed || sheetParsed.entries.length === 0) return;
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const entries = sheetParsed.entries;
      // 批量端点单次上限 2000 条，分批发（整月满打满算 31天×5晚×4档=620 条，留足余量）
      for (let i = 0; i < entries.length; i += IMPORT_BATCH_SIZE) {
        await api.upsertSettlementRates(token, entries.slice(i, i + IMPORT_BATCH_SIZE));
      }
      setNotice(`报价表已导入 ${entries.length} 格地面结算价`);
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
    // 草稿与已加载态是否有差异（控制保存按钮）
    for (const date of days) {
      for (const nights of NIGHTS_OPTIONS) {
        const key = cellKey(date, nights);
        const trimmed = (draft.get(key) ?? '').trim();
        const existing = rateByKey.get(key);
        if (trimmed === '' && existing) return true;
        if (trimmed !== '' && (!existing || String(existing.pricePerPersonCny) !== trimmed)) return true;
      }
    }
    return false;
  }, [draft, days, rateByKey]);

  const daySet = useMemo(() => new Set(days), [days]);

  // 解析结果里落在当前显示范围外的条目数（照样入库，但当前网格看不到）
  const sheetOutsideWindow = useMemo(() => {
    if (!sheetParsed) return { past: 0, outside: 0 };
    return sheetParsed.entries.reduce(
      (counts, entry) => {
        if (entry.departDate < today) counts.past += 1;
        else if (!daySet.has(entry.departDate)) counts.outside += 1;
        return counts;
      },
      { past: 0, outside: 0 },
    );
  }, [daySet, sheetParsed, today]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">结算价日历</h1>
          <p className="mt-1 text-xs text-ink-muted">
            {tab === 'GROUND'
              ? '按「出发日期 × 晚数 × 酒店档次」维护每人同业结算价。代理下配了档次/晚数的套餐单时，系统按去程出发日期在此表自动取每人结算价（代理改不了）。'
              : '按「出发日期 × 航班号」维护每人机票同业结算价（运营的机票报价表）。代理下纯机票单时，系统按各航段的航班号 + 出发日在此表自动取每人结算价（代理改不了）。'}
          </p>
        </div>
      </div>

      {/* 页签：地面整包价 / 机票结算价（两张表口径不同，各管各的） */}
      <div className="flex gap-1 border-b border-slate-200">
        {(
          [
            ['GROUND', '地面结算价'],
            ['FLIGHT', '机票结算价'],
          ] as Array<[RateTab, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={
              value === tab
                ? '-mb-px border-b-2 border-indigo-600 px-4 py-2 text-sm font-semibold text-indigo-700'
                : '-mb-px border-b-2 border-transparent px-4 py-2 text-sm text-ink-muted hover:text-ink'
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'FLIGHT' && <FlightSettlementRatesPanel />}
      {tab === 'GROUND' && (

      <section className="card space-y-4">
        {/* 控制区：起始日期 + 窗口导航 + 档次（档次切换即换一张网格） */}
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
          <div>
            <label className="label">酒店档次</label>
            <div className="flex gap-1">
              {TIERS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTier(t)}
                  className={
                    t === tier
                      ? 'rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white'
                      : 'rounded-md bg-slate-100 px-3 py-1.5 text-sm text-ink hover:bg-slate-200'
                  }
                >
                  {TIER_LABELS[t]}
                </button>
              ))}
            </div>
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
        {/* 报价表整块粘贴导入：一次吃整张套票表（四个档次一起进），与下方逐格粘贴并存 */}
        <details className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2">
          <summary className="cursor-pointer text-sm font-semibold text-ink">
            📋 粘贴报价表（整块导入四个档次）
          </summary>
          <div className="mt-3 space-y-3">
            <p className="text-[11px] text-ink-muted">
              从报价表 Excel 里整块复制（含表头也没关系），直接粘贴到下框 →「解析预览」核对 →「确认导入」。
              回程行、公告行、以及「/」或空着的档次会自动跳过（不写也不清空既有价）；同一格重复出现取最后一次。
              日期只写月日（如 8/12）时按起始日期所在月份的年份补全。
            </p>
            <textarea
              className="input h-40 w-full font-mono text-xs"
              placeholder="在这里粘贴报价表内容（日期 / 晚数 / 星期 / 时刻 / 航段 / 四档价格…）"
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
                  {sheetOutsideWindow.past > 0 &&
                    `；其中 ${sheetOutsideWindow.past} 条为过去日期，已入库但日历不再展示`}
                  {sheetOutsideWindow.outside > 0 &&
                    `；${sheetOutsideWindow.past > 0 ? '另有' : '其中'} ${sheetOutsideWindow.outside} 条不在当前显示范围，导入后请调整起始日期查看`}
                </div>

                {sheetParsed.entries.length === 0 && sheetParsed.skipped.length === 0 && (
                  <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
                    没认出任何价格。请确认复制的是报价表整块内容（要带日期、晚数、航段和四档价格列）。
                  </div>
                )}

                {sheetParsed.entries.length > 0 && (
                  <div className="max-h-64 overflow-auto rounded-md border border-slate-200 bg-white">
                    <table className="min-w-full text-xs">
                      <thead className="sticky top-0 bg-slate-50 text-left text-ink-muted">
                        <tr>
                          <th className="px-3 py-1.5 font-medium">出发日期</th>
                          <th className="px-3 py-1.5 font-medium">晚数</th>
                          <th className="px-3 py-1.5 font-medium">档次</th>
                          <th className="px-3 py-1.5 text-right font-medium">每人结算价</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sheetParsed.entries.map((e) => (
                          <tr
                            key={`${e.departDate}-${e.nights}-${e.tier}`}
                            className="border-t border-slate-100"
                          >
                            <td className="px-3 py-1 tabular-nums">{e.departDate}</td>
                            <td className="px-3 py-1">{e.nights}晚</td>
                            <td className="px-3 py-1">{TIER_LABELS[e.tier]}</td>
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
          提示：行 = 起始日期起 31 天，列 = 晚数（1–5晚），档次在上方切换。可从 Excel 复制一块「日期 ×
          晚数」区域，选中起始格后直接粘贴（Ctrl/⌘+V）批量填充；清空格子并保存即删除该价。
        </p>

        {/* 网格：行 = 起始日期起 31 天，列 = 晚数（1–5晚）；档次由上方筛选器切换 */}
        {loading ? (
          <div className="py-10 text-center text-sm text-ink-muted">加载中…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-ink-muted">
                  <th className="sticky left-0 z-10 bg-white px-3 py-2 font-medium">出发日期</th>
                  {NIGHTS_OPTIONS.map((n) => (
                    <th key={n} className="px-3 py-2 text-center font-medium">
                      {n}晚
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
                      {NIGHTS_OPTIONS.map((nights, nightIdx) => {
                        const key = cellKey(date, nights);
                        const existing = rateByKey.get(key);
                        return (
                          <td key={nights} className="px-1 py-1">
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
                              onChange={(e) => setCell(date, nights, e.target.value)}
                              onPaste={(e) => handlePaste(e, dayIdx, nightIdx)}
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
      )}
    </div>
  );
}
