/**
 * no-show 报表 · ADMIN/STAFF
 *
 * 按班次聚合：标了多少人、释放/恢复了多少座、有没有因此超售顶掉别人、最后还有多少座停在「已释放」。
 * 数据与导出同源（服务端一套口径），本页不做二次计算 —— 合计行优先用服务端 totals，
 * 服务端没下发某一项时才用当前行求和兜底。
 *
 * 点行 → 跳订单列表，带上「航段状态=去程未登机 + 该航班 + 该出发日」的筛选。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, type NoShowReportRow, type NoShowReportTotals } from '../lib/api';
import { useAuth } from '../stores/auth';
import { Icon } from '../components/Icon';
import { NoShowTabs } from './no-show/NoShowTabs';

function ymdOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 合计口径：服务端 totals 优先，缺项才用当前行求和 */
function totalOf(
  key: keyof NoShowReportTotals,
  totals: NoShowReportTotals | null,
  rows: NoShowReportRow[],
): number {
  const fromServer = totals?.[key];
  if (typeof fromServer === 'number') return fromServer;
  return rows.reduce((sum, r) => sum + (r[key] ?? 0), 0);
}

const COLUMNS: Array<{ key: keyof NoShowReportTotals; label: string; hint: string }> = [
  { key: 'orders', label: '订单数', hint: '本班次涉及 no-show 处理的订单张数' },
  { key: 'noShowPax', label: 'no-show 人数', hint: '标记为未登机的乘客人数' },
  { key: 'releasedSeats', label: '释放座位', hint: '回程座位放回库存的累计座数' },
  { key: 'restoredSeats', label: '恢复座位', hint: '释放后又被恢复回去的座数' },
  { key: 'oversoldSeats', label: '超售', hint: '释放后重新卖出导致容量被卖穿的座数' },
  { key: 'displacedSeats', label: '被顶座', hint: '因超售被顶掉、需要另行安排的座数' },
  { key: 'voidedSeats', label: '作废座位', hint: '起飞后自动作废、不再可恢复的座数' },
  {
    key: 'stillReleasedSeats',
    label: '仍释放中',
    hint: '当前仍停在「已释放」、既没卖掉也没恢复的座数',
  },
  { key: 'workOrdersOpen', label: '未结工单', hint: '撤名单 / 退票工单里还没处理完的条数' },
];

export function NoShowReportPage() {
  const token = useAuth((s) => s.tokens?.accessToken) ?? '';
  const navigate = useNavigate();

  const [from, setFrom] = useState(ymdOffset(-30));
  const [to, setTo] = useState(ymdOffset(0));
  const [rows, setRows] = useState<NoShowReportRow[]>([]);
  const [totals, setTotals] = useState<NoShowReportTotals | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.noShow
      .report(token, { from: from || undefined, to: to || undefined })
      .then((res) => {
        if (cancelled) return;
        setRows(res.rows);
        setTotals(res.totals ?? null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setRows([]);
        setTotals(null);
        setError(e instanceof ApiError ? e.message : '加载报表失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, from, to, reloadNonce]);

  const setLast30 = () => {
    setFrom(ymdOffset(-30));
    setTo(ymdOffset(0));
  };

  const handleExport = useCallback(async () => {
    if (!token) return;
    setExporting(true);
    try {
      const blob = await api.noShow.exportReport(token, {
        from: from || undefined,
        to: to || undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `no-show报表_${from || '全部'}_${to || from || '全部'}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      alert(e instanceof ApiError ? `导出失败：${e.message}` : '导出失败');
    } finally {
      setExporting(false);
    }
  }, [token, from, to]);

  /**
   * 跳订单列表：只带航班号 + 出发日，**不带** legFlag=NO_SHOW。
   *
   * legFlag 是单值物化列，优先级里 NO_SHOW 排最后（作废 > 已释放 > 已恢复 > 去程未登机）：
   * 标了 no-show 又释放了回程的单，legFlag 已经是 RETURN_RELEASED —— 按 NO_SHOW 筛几乎必空，
   * 而这恰恰是报表里数量最多的那一档。宁可列表宽一点（该班次该日的单都在），也别给一张空表。
   */
  const openOrders = (row: NoShowReportRow) => {
    const qs = new URLSearchParams({
      flightNumber: row.flightNumber,
      flightDateFrom: row.departDate,
      flightDateTo: row.departDate,
    });
    navigate(`/orders?${qs.toString()}`);
  };

  const totalRow = useMemo(
    () => COLUMNS.map((c) => ({ key: c.key, value: totalOf(c.key, totals, rows) })),
    [totals, rows],
  );

  return (
    <div className="space-y-5">
      <section>
        <h1 className="page-title">no-show 报表</h1>
        <p className="page-sub">
          按班次看 no-show 的后续影响：释放了多少座、又恢复回去多少、有没有卖穿导致别人被顶，
          以及现在还有多少座停在「已释放」没有着落。点某一行可以直接跳到该航班当日的订单列表
          （到了列表再按「航段状态」细筛）。
        </p>
      </section>

      <NoShowTabs />

      <section className="card">
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <label className="label" htmlFor="no-show-report-from">
              出发日期 · 起始
            </label>
            <input
              id="no-show-report-from"
              type="date"
              className="input"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="no-show-report-to">
              出发日期 · 截止
            </label>
            <input
              id="no-show-report-to"
              type="date"
              className="input"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="flex items-end gap-2 md:col-span-2">
            <button type="button" className="btn-secondary text-sm" onClick={setLast30}>
              近 30 天
            </button>
            <button
              type="button"
              className="btn-secondary text-sm"
              onClick={() => setReloadNonce((n) => n + 1)}
            >
              <Icon name="refresh" /> 刷新
            </button>
            <button
              type="button"
              className="btn-primary text-sm"
              disabled={loading || exporting}
              onClick={() => void handleExport()}
              title="按当前日期区间导出 xlsx（与页面同一套口径）"
            >
              <Icon name="download" /> {exporting ? '导出中…' : '导出 xlsx'}
            </button>
          </div>
        </div>
        <p className="mt-2 text-sm text-slate-500">
          显示 {rows.length} 个班次
          <span className="ml-2 text-xs text-ink-muted">
            日期两端都可留空（不填按近 30 天算）；单次最多查 92 天，超了服务端会让你分段。
          </span>
        </p>
      </section>

      {error && <div className="card border-rose-200 bg-rose-50 text-rose-700">{error}</div>}

      <section className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="table-admin">
            <thead>
              <tr>
                <th className="text-left">出发日期</th>
                <th className="text-left">航班号</th>
                {COLUMNS.map((c) => (
                  <th key={c.key} className="!text-right" title={c.hint}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={COLUMNS.length + 2} className="px-3 py-8 text-center text-ink-muted">
                    加载中…
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS.length + 2} className="px-3 py-8 text-center text-ink-muted">
                    这段时间没有 no-show 记录。
                  </td>
                </tr>
              )}
              {!loading &&
                rows.map((row) => (
                  <tr
                    key={row.scheduleId}
                    className="cursor-pointer"
                    title="按该航班 + 该出发日查订单列表（含未处理的单，可在列表里按航段状态再筛）"
                    onClick={() => openOrders(row)}
                  >
                    <td className="nums">{row.departDate}</td>
                    <td>
                      {/* 整行可点，但键盘用户需要一个真正可聚焦的目标 —— 航班号就是那个入口 */}
                      <button
                        type="button"
                        className="rounded font-medium text-ink hover:text-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
                        onClick={(e) => {
                          e.stopPropagation();
                          openOrders(row);
                        }}
                      >
                        {row.flightNumber}
                      </button>
                    </td>
                    {COLUMNS.map((c) => {
                      const value = row[c.key] ?? 0;
                      // 超售/被顶是真出事了，标红；仍释放中与未结工单是待办，标琥珀
                      const tone =
                        (c.key === 'oversoldSeats' || c.key === 'displacedSeats') && value > 0
                          ? 'text-rose-600 font-semibold'
                          : (c.key === 'stillReleasedSeats' || c.key === 'workOrdersOpen') &&
                              value > 0
                            ? 'text-amber-600 font-medium'
                            : '';
                      return (
                        <td key={c.key} className={`nums text-right ${tone}`}>
                          {value.toLocaleString()}
                        </td>
                      );
                    })}
                  </tr>
                ))}
            </tbody>
            {!loading && rows.length > 0 && (
              <tfoot>
                <tr className="bg-slate-50/70 font-semibold text-ink">
                  <td className="px-3 py-2.5" colSpan={2}>
                    合计
                  </td>
                  {totalRow.map((t) => (
                    <td key={t.key} className="nums px-3 py-2.5 text-right">
                      {t.value.toLocaleString()}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>
    </div>
  );
}
