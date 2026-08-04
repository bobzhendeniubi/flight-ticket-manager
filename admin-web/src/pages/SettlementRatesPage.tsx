/**
 * 结算价日历 · ADMIN/STAFF — 运营维护「出发日期 × 晚数 × 酒店档次」的每人同业结算价（代理不可见）
 *
 * 数据源：backend/src/modules/settlement-rates/*
 *   GET    /settlement-rates?from&to&tier     网格查询（缺省 nights = 返回区间内全部晚数）
 *   PUT    /settlement-rates/batch            批量 upsert（整批保存 / Excel 粘贴块）
 *   DELETE /settlement-rates/:id              删除一格
 *
 * 口径：选「月份 + 档次」→ 网格（行 = 该月每天，列 = 晚数 1–5）。格子直接编辑、整批保存；
 * 支持从 Excel 复制块状粘贴（tab/换行解析，与运营报价表「一个日期分几晚」逐列对应）；
 * 代理下套餐单时按去程出发日期 + 晚数 + 档次在此表自动取每人价。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  type SettlementRate,
  type SettlementRateWriteEntry,
  type SettlementTier,
} from '../lib/api';
import { useAuth } from '../stores/auth';

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
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 某月（YYYY-MM）→ 该月每天的 YMD 列表（UTC 历法，避免时区跨日）。 */
function daysInMonth(ym: string): string[] {
  const m = /^(\d{4})-(\d{2})$/u.exec(ym);
  if (!m) return [];
  const year = Number(m[1]);
  const month = Number(m[2]);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from(
    { length: last },
    (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`,
  );
}

/** YMD → 周几（0=日）；纯 UTC，展示星期列用。 */
function weekdayOf(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(ymd);
  if (!m) return 0;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

function cellKey(date: string, nights: number): string {
  return `${date}__${nights}`;
}

/** 粘贴单元格里的数字：去掉 ¥ / 逗号 / 空格，保留纯数字串（空串 = 清空该格）。 */
function normalizePasteCell(raw: string): string {
  return raw.replace(/[¥,\s]/gu, '').trim();
}

export function SettlementRatesPage() {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';

  const [month, setMonth] = useState<string>(currentMonth());
  const [tier, setTier] = useState<SettlementTier>(TIERS[0]);
  const [rates, setRates] = useState<SettlementRate[]>([]);
  // 编辑草稿：cellKey → 输入框字符串（空串 = 清空该格）。整批保存时与已加载 rates 对比出增删改。
  const [draft, setDraft] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pasteWarning, setPasteWarning] = useState<string | null>(null);
  // 数据变更后 +1 触发重拉
  const [nonce, setNonce] = useState(0);

  const days = useMemo(() => daysInMonth(month), [month]);

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
      // 不传 nights：一次拉取当月该档次下全部晚数（1–5 晚全列齐）
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
  }, [token, month, tier, nonce]);

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
   * 粘贴区域超出网格范围（行超出当月天数 / 列超出 5 晚）时该部分静默丢弃，但会提示丢弃了多少格。
   */
  function handlePaste(
    e: React.ClipboardEvent<HTMLInputElement>,
    startDayIdx: number,
    startNightIdx: number,
  ) {
    const text = e.clipboardData.getData('text');
    if (!text || (!text.includes('\t') && !text.includes('\n'))) return; // 单值 → 默认行为
    e.preventDefault();
    const rows = text
      .replace(/\r/gu, '')
      .split('\n')
      .filter((row, i, arr) => !(i === arr.length - 1 && row === '')); // 去掉末尾空行
    const updates: Array<[string, string]> = [];
    let overflow = 0;
    rows.forEach((row, r) => {
      row.split('\t').forEach((raw, c) => {
        const dayIdx = startDayIdx + r;
        const nightIdx = startNightIdx + c;
        if (dayIdx >= days.length || nightIdx >= NIGHTS_OPTIONS.length) {
          overflow += 1;
          return;
        }
        updates.push([cellKey(days[dayIdx], NIGHTS_OPTIONS[nightIdx]), normalizePasteCell(raw)]);
      });
    });
    setDraft((prev) => {
      const next = new Map(prev);
      for (const [key, value] of updates) next.set(key, value);
      return next;
    });
    setPasteWarning(overflow > 0 ? `粘贴溢出 ${overflow} 格已忽略（超出当月天数或超过 5 晚）` : null);
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">结算价日历</h1>
          <p className="mt-1 text-xs text-ink-muted">
            按「出发日期 × 晚数 × 酒店档次」维护每人同业结算价。代理下配了档次/晚数的套餐单时，
            系统按去程出发日期在此表自动取每人结算价（代理改不了）。
          </p>
        </div>
      </div>

      <section className="card space-y-4">
        {/* 控制区：月份 + 档次（档次切换即换一张网格） */}
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="label">月份</label>
            <input
              type="month"
              className="input"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
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
        <p className="text-[11px] text-ink-muted">
          提示：行 = 该月每天，列 = 晚数（1–5晚），档次在上方切换。可从 Excel 复制一块「日期 ×
          晚数」区域，选中起始格后直接粘贴（Ctrl/⌘+V）批量填充；清空格子并保存即删除该价。
        </p>

        {/* 网格：行 = 该月每天，列 = 晚数（1–5晚）；档次由上方筛选器切换 */}
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
    </div>
  );
}
