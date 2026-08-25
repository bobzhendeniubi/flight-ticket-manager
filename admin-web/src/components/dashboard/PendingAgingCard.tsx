/**
 * 待支付订单账龄卡片 —— 让「占着机位、又没有支付时限」的单第一天就看得见。
 *
 * 为什么要有这张卡：
 *   后台/代理录入的待支付单不设支付时限，机位不会自动退，只能人工释放。
 *   仪表盘原来只有一个「待支付订单 N」的裸计数，看不出这 N 单里哪些已经躺了一周、
 *   哪些根本没有时限 —— 一张录错的单能一直冻着机位，直到有人想起来去翻订单列表。
 *   这里把账龄摊开成四档，并单独标出「无支付时限」的单，点开就能看到是谁的单、
 *   哪天出发、冻了几个座。
 *
 * A12（2026-07-17）：从「只看得见」升级为「看得见 + 一键处置」——下钻明细可勾选订单
 * 批量取消（走状态机 PENDING_PAYMENT→CANCELLED，自动还座）。仍是人工决策：
 * 录单单永不自动过期是拍板口径（"肯定要飞"），这里只是把人工释放从翻订单列表缩短成一次勾选。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiFetch, ApiError } from '../../lib/api';
import { useAuth } from '../../stores/auth';
import { useConfirm } from '../ConfirmDialog';

type PendingAgingBucket = 'LT_24H' | 'D1_3' | 'D3_7' | 'GT_7D';

interface PendingAgingBucketStat {
  bucket: PendingAgingBucket;
  orders: number;
  noClockOrders: number;
}

interface PendingAgingSummary {
  buckets: PendingAgingBucketStat[];
  totalOrders: number;
  totalNoClockOrders: number;
  asOf: string;
}

interface PendingAgingOrderRow {
  id: string;
  orderNumber: string;
  createdAt: string;
  ageHours: number;
  bucket: PendingAgingBucket;
  noClock: boolean;
  agentId: string | null;
  agentName: string | null;
  contactName: string;
  departureDate: string | null;
  seats: number;
}

const BUCKET_ORDER: PendingAgingBucket[] = ['LT_24H', 'D1_3', 'D3_7', 'GT_7D'];

const BUCKET_LABEL: Record<PendingAgingBucket, string> = {
  LT_24H: '24 小时内',
  D1_3: '1-3 天',
  D3_7: '3-7 天',
  GT_7D: '超过 7 天',
};

// 越老越扎眼：新单中性，老单升到琥珀/玫红。视觉排序就是处理优先级。
const BUCKET_TONE: Record<PendingAgingBucket, string> = {
  LT_24H: 'text-ink',
  D1_3: 'text-ink',
  D3_7: 'text-amber-600',
  GT_7D: 'text-rose-600',
};

const DRILL_PAGE_SIZE = 50;

/** 账龄小时数 → 运营看得懂的说法 */
function formatAge(ageHours: number): string {
  if (ageHours < 24) return `${ageHours} 小时`;
  const days = Math.floor(ageHours / 24);
  const hours = ageHours % 24;
  return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
}

export function PendingAgingCard() {
  const confirm = useConfirm();
  const confirmLockRef = useRef(false);
  const tokens = useAuth((s) => s.tokens);
  const [summary, setSummary] = useState<PendingAgingSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  // 下钻状态：选中哪一档 + 是否只看无支付时限的单。null = 收起。
  const [openBucket, setOpenBucket] = useState<PendingAgingBucket | null>(null);
  const [noClockOnly, setNoClockOnly] = useState(false);
  const [rows, setRows] = useState<PendingAgingOrderRow[]>([]);
  const [rowsTotal, setRowsTotal] = useState(0);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState<string | null>(null);

  const token = tokens?.accessToken;

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    apiFetch<{ summary: PendingAgingSummary }>('/dashboard/pending-aging', { token })
      .then((res) => {
        if (!cancelled) {
          setSummary(res.summary);
          setSummaryError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setSummaryError(e instanceof ApiError ? e.message : '加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const loadRows = useCallback(
    (bucket: PendingAgingBucket, onlyNoClock: boolean) => {
      if (!token) return;
      let cancelled = false;
      setRowsLoading(true);
      setRowsError(null);
      const qs = new URLSearchParams({ bucket, page: '1', pageSize: String(DRILL_PAGE_SIZE) });
      if (onlyNoClock) qs.set('noClockOnly', 'true');
      apiFetch<{ orders: PendingAgingOrderRow[]; total: number }>(
        `/dashboard/pending-aging/orders?${qs.toString()}`,
        { token },
      )
        .then((res) => {
          if (cancelled) return;
          setRows(res.orders);
          setRowsTotal(res.total);
        })
        .catch((e) => {
          if (!cancelled) setRowsError(e instanceof ApiError ? e.message : '加载失败');
        })
        .finally(() => {
          if (!cancelled) setRowsLoading(false);
        });
      return () => {
        cancelled = true;
      };
    },
    [token],
  );

  // 选档/切「只看无时限」时重拉明细
  useEffect(() => {
    if (!openBucket) return;
    return loadRows(openBucket, noClockOnly);
  }, [openBucket, noClockOnly, loadRows]);

  function toggleBucket(bucket: PendingAgingBucket) {
    setOpenBucket((cur) => (cur === bucket ? null : bucket));
    setSelected(new Set()); // 切档清空勾选，避免跨档误操作
    setReleaseMsg(null);
  }

  // ── A12 一键处置：勾选 → 批量取消（状态机自动还座）──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [releasing, setReleasing] = useState(false);
  const [releaseMsg, setReleaseMsg] = useState<string | null>(null);

  const toggleRow = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function releaseSelected() {
    if (!token || releasing || selected.size === 0 || confirmLockRef.current) return;
    const totalSeats = rows.filter((r) => selected.has(r.id)).reduce((sum, r) => sum + r.seats, 0);
    confirmLockRef.current = true;
    if (!(await confirm({
      title: `确认取消所选 ${selected.size} 单（释放约 ${totalSeats} 个机位）？`,
      body: '订单将转为「已取消」，座位自动归还销售；此操作不可批量撤销（可逐单拉回待支付）。',
      tone: 'danger',
    }))) {
      confirmLockRef.current = false;
      return;
    }
    setReleasing(true);
    setReleaseMsg(null);
    try {
      const res = await api.batchUpdateOrderStatus(
        token,
        [...selected],
        'CANCELLED',
        '账龄处置：人工释放机位（待支付超期）',
      );
      setReleaseMsg(
        res.failureCount > 0
          ? `已取消 ${res.successCount} 单，失败 ${res.failureCount} 单（${res.results.find((r) => !r.success)?.error ?? ''}）`
          : `已取消 ${res.successCount} 单，机位已归还销售`,
      );
      setSelected(new Set());
      if (openBucket) loadRows(openBucket, noClockOnly); // 重拉明细与汇总
    } catch (e) {
      setReleaseMsg(e instanceof ApiError ? e.message : '批量取消失败');
    } finally {
      setReleasing(false);
      confirmLockRef.current = false;
    }
  }

  return (
    <section className="card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">待支付订单账龄</h2>
          <p className="mt-1 text-xs text-ink-muted">待支付的单都占着机位。点任意一档看明细。</p>
        </div>
        {summary && summary.totalNoClockOrders > 0 && (
          <span className="badge-warning">
            {summary.totalNoClockOrders} 单无支付时限 · 机位不会自动退
          </span>
        )}
      </div>

      {summaryError && (
        <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {summaryError}
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {BUCKET_ORDER.map((bucket) => {
          const stat = summary?.buckets.find((b) => b.bucket === bucket);
          const active = openBucket === bucket;
          return (
            <button
              key={bucket}
              type="button"
              onClick={() => toggleBucket(bucket)}
              aria-expanded={active}
              className={`rounded-lg border px-4 py-3 text-left transition hover:border-brand hover:bg-brand-50/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                active ? 'border-brand bg-brand-50/60' : 'border-slate-200'
              }`}
            >
              <p className="text-xs font-medium text-ink-muted">{BUCKET_LABEL[bucket]}</p>
              <p className={`nums mt-1 text-2xl font-semibold ${BUCKET_TONE[bucket]}`}>
                {stat ? stat.orders : '—'}
              </p>
              <p className="mt-0.5 text-xs text-ink-muted">
                {stat && stat.noClockOrders > 0 ? (
                  <span className="font-medium text-amber-700">
                    其中 {stat.noClockOrders} 单无支付时限
                  </span>
                ) : (
                  '无支付时限 0 单'
                )}
              </p>
            </button>
          );
        })}
      </div>

      {openBucket && (
        <div className="mt-5 border-t border-slate-200 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-ink">
              {BUCKET_LABEL[openBucket]}
              <span className="ml-2 text-xs font-normal text-ink-muted">
                共 {rowsTotal} 单
                {rowsTotal > DRILL_PAGE_SIZE && ` · 只显示最久的 ${DRILL_PAGE_SIZE} 单`}
              </span>
            </h3>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-soft">
                <input
                  type="checkbox"
                  checked={noClockOnly}
                  onChange={(e) => setNoClockOnly(e.target.checked)}
                  className="rounded border-slate-300"
                />
                只看无支付时限的单
              </label>
              <button
                type="button"
                className="btn-secondary text-xs disabled:opacity-50"
                onClick={releaseSelected}
                disabled={releasing || selected.size === 0}
                title="取消所选待支付订单，座位自动归还销售（状态机保护，可逐单拉回）"
              >
                {releasing ? '释放中…' : `释放所选机位（${selected.size}）`}
              </button>
            </div>
          </div>
          {releaseMsg && (
            <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-ink">
              {releaseMsg}
            </div>
          )}

          {rowsError && (
            <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {rowsError}
            </div>
          )}

          <div className="mt-3 overflow-x-auto">
            <table className="table-admin">
              <thead>
                <tr>
                  <th className="w-8">
                    <input
                      type="checkbox"
                      className="rounded border-slate-300"
                      checked={rows.length > 0 && selected.size === rows.length}
                      onChange={(e) =>
                        setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                      }
                      title="全选当前页"
                    />
                  </th>
                  <th className="text-left">订单号</th>
                  <th className="text-left">代理</th>
                  <th className="text-left">联系人</th>
                  <th className="text-left">出发日</th>
                  <th className="text-right">账龄</th>
                  <th className="text-right">占座人数</th>
                  <th className="text-center">支付时限</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <input
                        type="checkbox"
                        className="rounded border-slate-300"
                        checked={selected.has(r.id)}
                        onChange={() => toggleRow(r.id)}
                      />
                    </td>
                    <td className="font-mono text-xs text-ink-soft">{r.orderNumber}</td>
                    <td className="text-ink">
                      {r.agentName ?? <span className="text-ink-muted">直客</span>}
                    </td>
                    <td className="text-ink-soft">{r.contactName}</td>
                    <td className="nums text-ink-soft">
                      {r.departureDate ?? <span className="text-ink-muted">—</span>}
                    </td>
                    <td className="nums text-right text-ink-soft">{formatAge(r.ageHours)}</td>
                    <td className="nums text-right font-medium text-ink">{r.seats}</td>
                    <td className="text-center">
                      {r.noClock ? (
                        <span className="badge-warning">无 · 需人工释放</span>
                      ) : (
                        <span className="badge-neutral">有</span>
                      )}
                    </td>
                  </tr>
                ))}
                {rowsLoading && (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-ink-muted">
                      加载中…
                    </td>
                  </tr>
                )}
                {!rowsLoading && rows.length === 0 && !rowsError && (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-ink-muted">
                      这一档没有待支付订单
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
