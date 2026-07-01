/**
 * 房控 · ADMIN/STAFF — 酒店切房台账（代理/客户不可见）
 *
 * 数据源：backend/src/modules/hotel-control/*
 *   GET    /hotel-control/board?from&to            销控板（按酒店×日期：切/占/余）
 *   GET    /hotel-control/forward?from&to          远期视图（按日期跨酒店合计）
 *   GET    /hotel-control/block-periods            包房周期列表
 *   POST   /hotel-control/block-periods            新建周期
 *   PATCH  /hotel-control/block-periods/:id        改周期
 *   DELETE /hotel-control/block-periods/:id        删周期
 *
 * 口径：余量 = 包房（切房）− 用房（占房订单）；余量<0 红、=0 黄。
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type BlockPeriodWriteInput,
  type HotelBlockPeriod,
  type HotelControlAlerts,
  type HotelControlBoard,
  type HotelControlForward,
  type OrderSummary,
  type RoomGroup,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { NumberInput } from '../components/NumberInput';
import { RoomingEditor, type RoomingPassenger } from '../components/RoomingEditor';

// ── helpers ────────────────────────────────────────────────────────────────
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function plusDaysStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtCny(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
}
/** 余量/余房单元格配色：<0 红底白字加粗（超卖醒目）、=0 黄 */
function remainingCellCls(v: number): string {
  if (v < 0) return 'bg-rose-600 font-bold text-white';
  if (v === 0) return 'bg-amber-50 font-medium text-amber-700';
  return 'text-ink-soft';
}

/**
 * 拼房客（0.5 半间）逐日附加口径 + 物理房间口径 — 后端 board.hotels[].rows 新增（附加字段，向后兼容）。
 * api.ts 的 HotelControlBoardHotel.rows 尚未声明这些列，这里按可选读取，缺省即降级不显示。
 * physicalUsed = ceil(拼房客数/2) + 整间预订数；两位拼房共用 1 间，落单 1 位向上取整独占 1 间。
 */
type SharedRows = {
  sharedHalfCount?: number[];
  sharedOdd?: boolean[];
  physicalUsed?: number[];
  physicalRemaining?: number[];
};
function readShared(rows: unknown): SharedRows {
  const r = rows as SharedRows;
  return {
    sharedHalfCount: r.sharedHalfCount,
    sharedOdd: r.sharedOdd,
    physicalUsed: r.physicalUsed,
    physicalRemaining: r.physicalRemaining,
  };
}

// 矩阵 sticky 列宽：第一列（酒店）11rem，第二列（行标签）3.5rem
const STICKY_COL1 = 'sticky left-0 z-10 min-w-[11rem] bg-white';
const STICKY_COL2 = 'sticky left-[11rem] z-10 min-w-[3.5rem] bg-white';

export function HotelControlPage() {
  const tokens = useAuth((s) => s.tokens);
  const token = tokens?.accessToken ?? '';

  const [from, setFrom] = useState<string>(todayStr());
  const [to, setTo] = useState<string>(plusDaysStr(30));
  const [board, setBoard] = useState<HotelControlBoard | null>(null);
  const [forward, setForward] = useState<HotelControlForward | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 周期 CRUD 后 +1 触发销控板/远期重拉
  const [boardNonce, setBoardNonce] = useState(0);

  useEffect(() => {
    if (!token || !from || !to || from > to) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api.getHotelBoard(token, from, to), api.getHotelForward(token, from, to)])
      .then(([b, f]) => {
        if (cancelled) return;
        setBoard(b);
        setForward(f);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : '房控数据加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [token, from, to, boardNonce]);

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">房控</h1>
          <p className="page-sub">
            酒店切房台账：按日期看「包房（切了多少）/ 用房（订单占了多少）/ 余量」。余量
            <span className="badge-danger mx-1">&lt;0 超卖</span>
            <span className="badge-warning mr-1">=0 售罄</span>
            一眼可见。
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <label className="label">起始</label>
            <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="label">截止</label>
            <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      </section>

      {/* ── 提醒线横幅（超卖加房 / 富余退房 / 班次超开票上限）────────── */}
      <AlertsBanner token={token} />

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}
      {from > to && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          起始日不能晚于截止日
        </div>
      )}

      {/* ── 分房表导出（成都格式 xlsx）──────────────────────────── */}
      <RoomAllocationExport token={token} />

      {/* ── 订单分房（按订单号查 → 拖拽分房）────────────────────── */}
      <RoomingSection token={token} />

      {/* ── 销控矩阵（按酒店 × 日期）──────────────────────────────── */}
      <section className="card">
        <h2 className="text-sm font-semibold text-ink">销控矩阵（按酒店 × 日期）</h2>
        <p className="mt-1 text-xs text-ink-muted">
          每家酒店四行：包房 / 用房（床位口径）/ 物理房间 / 余量。横向滚动看更多日期（最长 120 天）。用房格出现
          <span className="mx-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-amber-100 px-1 text-[10px] font-semibold leading-none text-amber-700 ring-1 ring-amber-300">拼</span>
          表示当晚拼房客为奇数，有 1 位无法配对（需补单房差或另行配对）。
          「用房」为床位口径（拼房客各计 0.5，可为小数）；「物理房间」是实际占用的整间数（两位拼房共用 1 间，落单 1 位仍独占 1 间）。
        </p>
        {loading ? (
          <div className="mt-3 text-sm text-ink-muted">加载销控板…</div>
        ) : !board || board.hotels.length === 0 ? (
          <div className="mt-3 py-4 text-center text-sm text-ink-muted">
            该区间暂无包房周期或占房订单 · 先在下方「包房周期管理」新增周期
          </div>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="border-collapse text-sm nums">
              <thead className="text-xs text-ink-muted">
                <tr className="border-b border-slate-200">
                  <th className={`${STICKY_COL1} py-2 pr-2 text-left font-medium uppercase tracking-wide`}>酒店</th>
                  <th className={`${STICKY_COL2} py-2 pr-2 text-left font-normal`}></th>
                  {board.dates.map((d) => (
                    <th key={d} className="whitespace-nowrap px-2 py-2 text-right font-medium">
                      {d.slice(5)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {board.hotels.map((h) => (
                  <Fragment key={h.hotelId}>
                    <tr className="border-t border-slate-200">
                      <td rowSpan={4} className={`${STICKY_COL1} py-2 pr-2 align-top`}>
                        <div className="font-medium text-ink">{h.hotelName}</div>
                        {h.unitPrice != null && (
                          <div className="text-xs text-ink-muted">单价 {fmtCny(h.unitPrice)}/晚</div>
                        )}
                      </td>
                      <td className={`${STICKY_COL2} py-1 pr-2 text-xs text-ink-muted`}>包房</td>
                      {h.rows.block.map((v, i) => (
                        <td key={i} className="px-2 py-1 text-right text-ink-soft">{v}</td>
                      ))}
                    </tr>
                    <tr>
                      <td className={`${STICKY_COL2} py-1 pr-2 text-xs text-ink-muted`}>
                        用房<span className="ml-0.5 text-[10px] text-ink-muted/70">床位</span>
                      </td>
                      {h.rows.used.map((v, i) => {
                        const shared = readShared(h.rows);
                        const odd = shared.sharedOdd?.[i] === true;
                        const n = shared.sharedHalfCount?.[i] ?? 0;
                        return (
                          <td key={i} className="px-2 py-1 text-right text-ink-soft">
                            <span className="inline-flex items-center gap-1">
                              {v}
                              {odd && (
                                <span
                                  className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-amber-100 px-1 text-[10px] font-semibold leading-none text-amber-700 ring-1 ring-amber-300"
                                  title={`本日有 ${n} 位拼房客（奇数）——1 位需补单房差或另行配对`}
                                  aria-label={`本日有 ${n} 位拼房客（奇数），1 位需补单房差或另行配对`}
                                >
                                  拼
                                </span>
                              )}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                    <tr>
                      <td className={`${STICKY_COL2} py-1 pr-2 text-xs text-ink-muted`}>
                        物理房间
                      </td>
                      {h.rows.used.map((_, i) => {
                        const shared = readShared(h.rows);
                        const phys = shared.physicalUsed?.[i];
                        return (
                          <td key={i} className="px-2 py-1 text-right font-medium text-ink">
                            {phys == null ? '—' : phys}
                          </td>
                        );
                      })}
                    </tr>
                    <tr className="border-b border-slate-100">
                      <td className={`${STICKY_COL2} py-1 pr-2 text-xs text-ink-muted`}>余量</td>
                      {h.rows.remaining.map((v, i) => (
                        <td key={i} className={`px-2 py-1 text-right ${remainingCellCls(v)}`}>{v}</td>
                      ))}
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── 远期总量（按日期跨酒店合计）──────────────────────────── */}
      <section className="card">
        <h2 className="text-sm font-semibold text-ink">远期总量（跨酒店合计）</h2>
        <p className="mt-1 text-xs text-ink-muted">收客 = 占房订单合计；控房 = 切房合计；余房 = 控房 − 收客。</p>
        {loading ? (
          <div className="mt-3 text-sm text-ink-muted">加载远期视图…</div>
        ) : !forward || forward.dates.length === 0 ? (
          <div className="mt-3 py-4 text-center text-sm text-ink-muted">该区间暂无数据</div>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="border-collapse text-sm nums">
              <thead className="text-xs text-ink-muted">
                <tr className="border-b border-slate-200">
                  <th className={`${STICKY_COL1} py-2 pr-2 text-left font-medium uppercase tracking-wide`}>日期</th>
                  {forward.dates.map((d) => (
                    <th key={d} className="whitespace-nowrap px-2 py-2 text-right font-medium">
                      {d.slice(5)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-slate-100">
                  <td className={`${STICKY_COL1} py-1 pr-2 text-xs text-ink-muted`}>收客</td>
                  {forward.occupied.map((v, i) => (
                    <td key={i} className="px-2 py-1 text-right text-ink-soft">{v}</td>
                  ))}
                </tr>
                <tr className="border-b border-slate-100">
                  <td className={`${STICKY_COL1} py-1 pr-2 text-xs text-ink-muted`}>控房</td>
                  {forward.held.map((v, i) => (
                    <td key={i} className="px-2 py-1 text-right text-ink-soft">{v}</td>
                  ))}
                </tr>
                <tr>
                  <td className={`${STICKY_COL1} py-1 pr-2 text-xs text-ink-muted`}>余房</td>
                  {forward.remaining.map((v, i) => (
                    <td key={i} className={`px-2 py-1 text-right ${remainingCellCls(v)}`}>{v}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── 包房周期管理 ─────────────────────────────────────────── */}
      <BlockPeriodsEditor token={token} onChanged={() => setBoardNonce((n) => n + 1)} />
    </div>
  );
}

// ── 订单分房（按订单号查 → 拖拽分房）────────────────────────────────────────
/** 占位出行人（纯酒店/接送用联系人占位 documentNumber='N/A'）不进分房池。 */
function toRoomingPassengers(order: OrderSummary): RoomingPassenger[] {
  return order.passengers
    .filter((p) => p.documentNumber !== 'N/A')
    .map((p) => ({
      id: p.id,
      name: p.fullName,
      gender: p.gender ?? null,
    }));
}

function RoomingSection({ token }: { token: string }) {
  const [orderNo, setOrderNo] = useState('');
  const [order, setOrder] = useState<OrderSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function lookup(): Promise<void> {
    const q = orderNo.trim();
    if (!q) return;
    setLoading(true);
    setErr(null);
    setOrder(null);
    setSavedAt(null);
    try {
      // 列表按订单号模糊查 → 精确匹配优先 → getOrder 取完整出行人 + 现有分房
      const res = await api.listOrders(token, { search: q, pageSize: 10 });
      const hit = res.orders.find((o) => o.orderNumber === q) ?? res.orders[0];
      if (!hit) {
        setErr('未找到该订单号对应的订单');
        return;
      }
      const detail = await api.getOrder(token, hit.id);
      setOrder(detail.order);
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '订单查询失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(groups: RoomGroup[]): Promise<void> {
    if (!order) return;
    await api.updateRoomAssignment(token, order.id, groups);
    setSavedAt(Date.now());
  }

  const roomingPassengers = order ? toRoomingPassengers(order) : [];
  const seedHotelName = order?.roomAssignment?.roomGroups?.find((g) => g.hotelName)?.hotelName;

  return (
    <section className="card">
      <h2 className="text-sm font-semibold text-ink">订单分房（拖拽）</h2>
      <p className="mt-1 text-xs text-ink-muted">
        输入订单号查出订单，把出行人拖进房间决定谁和谁一起住。保存写入该订单的分房表（分房表导出会读取）。
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="grow sm:grow-0">
          <label className="label">订单号</label>
          <input
            className="input sm:w-64"
            placeholder="如 ST-20260625-0001"
            value={orderNo}
            onChange={(e) => setOrderNo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void lookup();
            }}
          />
        </div>
        <button className="btn-primary" onClick={() => void lookup()} disabled={loading || !orderNo.trim()}>
          {loading ? '查询中…' : '查订单'}
        </button>
      </div>

      {err && <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}

      {order && (
        <div className="mt-4">
          <div className="mb-2 text-xs text-ink-soft">
            订单 <b className="font-mono text-ink">{order.orderNumber}</b> · 联系人 {order.contactName}
            {savedAt != null && <span className="ml-2 text-emerald-700">· 分房已保存</span>}
          </div>
          {roomingPassengers.length === 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
              该订单暂无可分房的出行人。
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-slate-50/40 p-4">
              <RoomingEditor
                key={order.id}
                passengers={roomingPassengers}
                initial={order.roomAssignment?.roomGroups}
                hotelName={seedHotelName ?? undefined}
                onSave={handleSave}
                onClose={() => setOrder(null)}
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ── 提醒线横幅（GET /hotel-control/alerts；可折叠）──────────────────────────
/** "07-12" → "7/12"（提醒行里的紧凑日期） */
function fmtMonthDay(date: string): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function AlertsBanner({ token }: { token: string }) {
  const [alerts, setAlerts] = useState<HotelControlAlerts | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .getHotelAlerts(token)
      .then((a) => {
        if (!cancelled) setAlerts(a);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : '提醒线加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const total = alerts
    ? alerts.oversold.length + alerts.surplusSoon.length + alerts.overCapacitySchedules.length
    : 0;

  return (
    <section className="card">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          提醒线（超卖加房 / 富余退房 / 班次超开票上限）
          {alerts != null && total > 0 && (
            <span className="badge-danger">{total}</span>
          )}
        </h2>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="btn-ghost px-2 py-1 text-xs"
        >
          {open ? '收起 ▲' : '展开 ▼'}
        </button>
      </div>
      {open && (
        <div className="mt-3 space-y-1.5">
          {err ? (
            <div className="text-sm text-rose-600">{err}</div>
          ) : alerts == null ? (
            <div className="text-sm text-ink-muted">加载提醒…</div>
          ) : total === 0 ? (
            <div className="text-sm text-ink-muted">暂无提醒</div>
          ) : (
            <>
              {alerts.oversold.map((a, i) => (
                <div
                  key={`os-${i}`}
                  className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
                >
                  <span className="font-semibold">超卖 ⚠</span> {a.hotelName} {fmtMonthDay(a.date)}{' '}
                  <span className="nums">{a.used}/{a.block}</span> 缺 {a.deficit} 间 · 让地接加房
                </div>
              ))}
              {alerts.surplusSoon.map((a, i) => (
                <div
                  key={`sp-${i}`}
                  className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700"
                >
                  <span className="font-semibold">富余提醒</span> {a.hotelName} {fmtMonthDay(a.date)} 还剩{' '}
                  {a.surplus} 间 · 考虑退房
                </div>
              ))}
              {alerts.overCapacitySchedules.map((a, i) => (
                <div
                  key={`oc-${i}`}
                  className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-700"
                >
                  <span className="font-semibold">票务 ⚠</span> {a.flightNumber}{' '}
                  {fmtMonthDay(a.departureDate)} 已收客 {a.paxCount} 人 · 超过开票上限
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ── 分房表导出（GET /orders/export-room-allocation；成都格式 xlsx）──────────
function RoomAllocationExport({ token }: { token: string }) {
  const [exportFrom, setExportFrom] = useState<string>(todayStr());
  const [exportTo, setExportTo] = useState<string>(todayStr());
  const [exporting, setExporting] = useState(false);

  async function handleExport(): Promise<void> {
    if (!token) return;
    setExporting(true);
    try {
      const blob = await api.downloadRoomAllocation(token, { from: exportFrom, to: exportTo });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `分房表-${exportFrom}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: unknown) {
      alert(e instanceof ApiError ? `导出失败：${e.message}` : '导出失败');
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="card">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">导出分房表</h2>
          <p className="mt-1 text-xs text-ink-muted">
            成都格式 xlsx：每入住日期一个 sheet，按酒店分组（区间最长 14 天）。
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <label className="label">入住起</label>
            <input
              type="date"
              className="input"
              value={exportFrom}
              onChange={(e) => setExportFrom(e.target.value)}
            />
          </div>
          <div>
            <label className="label">入住止</label>
            <input
              type="date"
              className="input"
              value={exportTo}
              onChange={(e) => setExportTo(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={exporting || exportFrom > exportTo}
            className="btn-primary"
          >
            {exporting ? '导出中…' : '导出分房表'}
          </button>
        </div>
      </div>
      {exportFrom > exportTo && (
        <div className="mt-2 text-xs text-amber-700">入住起不能晚于入住止</div>
      )}
    </section>
  );
}

// ── 包房周期管理（镜像 FinancesPage 的 FlightCostPeriodsEditor 模式）────────
function BlockPeriodsEditor({ token, onChanged }: { token: string; onChanged: () => void }) {
  const [periods, setPeriods] = useState<HotelBlockPeriod[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [hotelOptions, setHotelOptions] = useState<{ id: string; label: string }[]>([]);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(() => {
    if (!token) return () => {};
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .listBlockPeriods(token)
      .then((d) => {
        if (cancelled) return;
        const sorted = [...d.periods].sort((a, b) => {
          if (a.hotelName !== b.hotelName) return a.hotelName.localeCompare(b.hotelName, 'zh-CN');
          return a.dateFrom.localeCompare(b.dateFrom);
        });
        setPeriods(sorted);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : '周期列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // 拉酒店下拉（产品 API；含停售酒店便于维护老台账）
  useEffect(() => {
    let cancelled = false;
    api
      .listHotels(false)
      .then((d) => {
        if (cancelled) return;
        const opts = d.hotels
          .map((h) => ({ id: h.id, label: h.code ? `${h.code} · ${h.name}` : h.name }))
          .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
        setHotelOptions(opts);
      })
      .catch(() => {
        // 静默：下拉空时表单按钮会禁用
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  async function onDelete(id: string): Promise<void> {
    if (!confirm('确认删除该包房周期？删除后该酒店该日期段的「包房」会相应减少。')) return;
    try {
      await api.deleteBlockPeriod(token, id);
      load();
      onChanged();
    } catch (e: unknown) {
      alert(e instanceof ApiError ? e.message : '删除失败');
    }
  }

  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">
            包房周期管理（按 酒店 × 日期段 定切房间数 / 单价；周期可叠加）
          </h2>
          <p className="mt-1 text-xs text-ink-muted">
            为某家酒店在某段日期切下固定间数。销控板的「包房」= 当天所有覆盖周期 rooms 之和。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowNew((v) => !v)}
          className={showNew ? 'btn-secondary py-1.5' : 'btn-primary py-1.5'}
        >
          {showNew ? '× 取消' : '+ 新增周期'}
        </button>
      </div>

      {showNew && (
        <BlockPeriodNewForm
          token={token}
          hotelOptions={hotelOptions}
          onSaved={() => {
            setShowNew(false);
            load();
            onChanged();
          }}
          onCancel={() => setShowNew(false)}
        />
      )}

      {loading ? (
        <div className="mt-3 text-sm text-ink-muted">加载周期…</div>
      ) : err ? (
        <div className="mt-3 text-sm text-rose-600">{err}</div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-ink-muted">
              <tr className="border-b border-slate-200">
                <th className="py-2 text-left font-medium">酒店</th>
                <th className="py-2 text-left font-medium">起始</th>
                <th className="py-2 text-left font-medium">结束</th>
                <th className="py-2 text-right font-medium">间数</th>
                <th className="py-2 text-right font-medium">单价(¥/间/晚)</th>
                <th className="py-2 text-left font-medium">备注</th>
                <th className="py-2 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {periods.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-4 text-center text-ink-muted">
                    暂无周期 · 点击右上「+ 新增周期」开始
                  </td>
                </tr>
              )}
              {periods.map((p) => (
                <BlockPeriodRow
                  key={p.id}
                  period={p}
                  token={token}
                  onSaved={() => {
                    load();
                    onChanged();
                  }}
                  onDelete={() => onDelete(p.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BlockPeriodNewForm({
  token,
  hotelOptions,
  onSaved,
  onCancel,
}: {
  token: string;
  hotelOptions: { id: string; label: string }[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [hotelId, setHotelId] = useState<string>(hotelOptions[0]?.id ?? '');
  const [dateFrom, setDateFrom] = useState<string>(todayStr());
  const [dateTo, setDateTo] = useState<string>(todayStr());
  const [rooms, setRooms] = useState<number | null>(null);
  const [unitPrice, setUnitPrice] = useState<number | null>(null);
  const [note, setNote] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 默认下拉同步
  useEffect(() => {
    if (!hotelId && hotelOptions.length > 0) {
      setHotelId(hotelOptions[0]!.id);
    }
  }, [hotelOptions, hotelId]);

  async function submit(): Promise<void> {
    if (!hotelId) {
      setErr('请选择酒店');
      return;
    }
    if (rooms == null) {
      setErr('请填写间数');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const body: BlockPeriodWriteInput = {
        hotelId,
        dateFrom,
        dateTo,
        rooms,
        unitPrice,
        note: note.trim() === '' ? null : note.trim(),
      };
      await api.createBlockPeriod(token, body);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '创建失败');
    } finally {
      setSaving(false);
    }
  }

  const inputCls = 'rounded-lg border border-slate-200 px-2 py-1 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';
  const numCls = 'w-24 rounded-lg border border-slate-200 px-1.5 py-0.5 text-right text-xs nums focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-canvas p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-xs text-ink-soft">
          酒店
          <select
            value={hotelId}
            onChange={(e) => setHotelId(e.target.value)}
            className={`mt-1 block w-full ${inputCls}`}
          >
            {hotelOptions.length === 0 && <option value="">（无可用酒店）</option>}
            {hotelOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="mt-1 block font-normal normal-case text-ink-muted">
            找不到酒店？在 产品管理 › 酒店 里添加/编辑（含介绍、图片、房型）。
          </span>
        </label>
        <label className="text-xs text-ink-soft">
          起始日
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className={`mt-1 block w-full ${inputCls}`}
          />
        </label>
        <label className="text-xs text-slate-600">
          结束日
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className={`mt-1 block w-full ${inputCls}`}
          />
        </label>
        <label className="text-xs text-ink-soft">
          间数
          <NumberInput
            className={`mt-1 block w-full ${numCls}`}
            step={1}
            min={0}
            integerOnly
            value={rooms}
            onChange={setRooms}
          />
        </label>
        <label className="text-xs text-ink-soft">
          切房单价(¥/间/晚)
          <NumberInput
            className={`mt-1 block w-full ${numCls}`}
            step={0.01}
            min={0}
            value={unitPrice}
            onChange={setUnitPrice}
          />
        </label>
        <label className="text-xs text-ink-soft">
          备注
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="可空"
            className={`mt-1 block w-full ${inputCls}`}
          />
        </label>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={saving || !hotelId}
          className="btn-primary py-1.5"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="btn-secondary py-1.5"
        >
          取消
        </button>
        {err && <span className="text-xs text-rose-600">{err}</span>}
      </div>
    </div>
  );
}

function BlockPeriodRow({
  period,
  token,
  onSaved,
  onDelete,
}: {
  period: HotelBlockPeriod;
  token: string;
  onSaved: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [dateFrom, setDateFrom] = useState<string>(period.dateFrom);
  const [dateTo, setDateTo] = useState<string>(period.dateTo);
  const [rooms, setRooms] = useState<number | null>(period.rooms);
  const [unitPrice, setUnitPrice] = useState<number | null>(period.unitPrice);
  const [note, setNote] = useState<string>(period.note ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset(): void {
    setDateFrom(period.dateFrom);
    setDateTo(period.dateTo);
    setRooms(period.rooms);
    setUnitPrice(period.unitPrice);
    setNote(period.note ?? '');
    setErr(null);
  }

  async function save(): Promise<void> {
    if (rooms == null) {
      setErr('请填写间数');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await api.updateBlockPeriod(token, period.id, {
        dateFrom,
        dateTo,
        rooms,
        unitPrice,
        note: note.trim() === '' ? null : note.trim(),
      });
      setEditing(false);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  const numCls = 'w-20 rounded-lg border border-slate-200 px-1.5 py-0.5 text-right text-xs nums focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';
  const dateCls = 'w-32 rounded-lg border border-slate-200 px-1.5 py-0.5 text-xs focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';
  const textCls = 'w-32 rounded-lg border border-slate-200 px-1.5 py-0.5 text-xs focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';

  if (!editing) {
    return (
      <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
        <td className="py-2 font-medium text-ink">{period.hotelName}</td>
        <td className="py-2 text-ink-soft">{period.dateFrom}</td>
        <td className="py-2 text-ink-soft">{period.dateTo}</td>
        <td className="py-2 text-right nums text-ink-soft">{period.rooms}</td>
        <td className="py-2 text-right nums text-ink-soft">{fmtCny(period.unitPrice)}</td>
        <td className="py-2 text-xs text-ink-muted">{period.note ?? '—'}</td>
        <td className="py-2 text-right">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="btn-secondary px-2 py-1 text-xs"
          >
            改
          </button>{' '}
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg border border-rose-200 px-2 py-1 text-xs font-medium text-rose-600 transition hover:bg-rose-50"
          >
            删
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-slate-100 bg-brand-50/50 last:border-0">
      <td className="py-2 font-medium text-ink">{period.hotelName}</td>
      <td className="py-2"><input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={dateCls} /></td>
      <td className="py-2"><input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={dateCls} /></td>
      <td className="py-2 text-right"><NumberInput className={numCls} step={1} min={0} integerOnly value={rooms} onChange={setRooms} /></td>
      <td className="py-2 text-right"><NumberInput className={numCls} step={0.01} min={0} value={unitPrice} onChange={setUnitPrice} /></td>
      <td className="py-2"><input type="text" value={note} onChange={(e) => setNote(e.target.value)} className={textCls} placeholder="备注" /></td>
      <td className="py-2 text-right">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="btn-primary px-2 py-1 text-xs"
        >
          {saving ? '…' : '保存'}
        </button>{' '}
        <button
          type="button"
          onClick={() => { reset(); setEditing(false); }}
          className="btn-secondary px-2 py-1 text-xs"
        >
          取消
        </button>
        {err && <div className="mt-0.5 text-xs text-rose-600">{err}</div>}
      </td>
    </tr>
  );
}
