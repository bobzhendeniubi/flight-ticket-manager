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
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  ApiError,
  hotelControlOpsApi,
  type BlockPeriodWriteInput,
  type HotelBlockPeriod,
  type HotelControlAlerts,
  type HotelControlBoard,
  type HotelControlForward,
  type HotelNightlyRemainingResult,
  type HotelOccupant,
  type OrderSummary,
  type RoomGroup,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { NumberInput } from '../components/NumberInput';
import { RoomingEditor, type RoomingPassenger } from '../components/RoomingEditor';
import { HotelSwapModal } from '../components/HotelSwapModal';

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
/**
 * 余量/余房单元格配色：
 *   block=0 且 used>0（该晚根本没配包房周期，remaining=0-used 是误导性负数）→ 琥珀色「未配包房」；
 *   block>0 且 remaining<0（真超卖）→ 红底白字加粗；
 *   remaining=0（售罄）→ 浅黄；其余正常。
 */
function remainingCellCls(remaining: number, block: number, used: number): string {
  if (block === 0 && used > 0) return 'bg-amber-200 font-semibold text-amber-900 ring-1 ring-amber-400';
  if (remaining < 0) return 'bg-rose-600 font-bold text-white';
  if (remaining === 0) return 'bg-amber-50 font-medium text-amber-700';
  return 'text-ink-soft';
}

/** 占房下钻订单状态中文名（只列 COUNTED_STATUSES 会出现的几种，够用即可）。 */
const OCCUPANT_STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  PROCESSING: '处理中',
  TICKETED: '已出票',
  COMPLETED: '已完成',
  REFUND_REQUESTED: '退款申请中',
  CHANGE_REQUESTED: '改期申请中',
  CHANGED: '已改期',
};

/** 复制订单号到剪贴板——OrdersPage 暂不支持按订单号深链跳转搜索，退而求其次的下钻动作。*/
function copyOrderNumber(orderNumber: string): void {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(orderNumber);
  }
}

/** 'YYYY-MM-DD' + 1 天。*/
function nextDayStr(d: string): string {
  const ms = new Date(`${d}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
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
  // 余量格点击下钻（某酒店某晚，谁占的）；null = 抽屉关闭
  const [drill, setDrill] = useState<{
    hotelId: string;
    hotelName: string;
    date: string;
    block: number;
    used: number;
  } | null>(null);

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

      {/* ── 房态导出（销控矩阵原样导出 xlsx）+ 按酒店导出护照 zip ── */}
      <BoardExport token={token} board={board} />

      {/* ── 订单分房（按订单号查 → 拖拽分房）────────────────────── */}
      <RoomingSection token={token} board={board} />

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
                      {h.rows.remaining.map((v, i) => {
                        const block = h.rows.block[i];
                        const used = h.rows.used[i];
                        const unconfigured = block === 0 && used > 0;
                        const date = board.dates[i];
                        return (
                          <td
                            key={i}
                            className={`cursor-pointer px-2 py-1 text-right transition hover:ring-1 hover:ring-brand/50 ${remainingCellCls(v, block, used)}`}
                            title={
                              unconfigured
                                ? '未配包房：该晚无包房周期覆盖，此数字非真实超卖 · 点击查看占房订单'
                                : '点击查看占房订单'
                            }
                            onClick={() =>
                              setDrill({ hotelId: h.hotelId, hotelName: h.hotelName, date, block, used })
                            }
                          >
                            {unconfigured ? '未配' : v}
                          </td>
                        );
                      })}
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
            {/* ── 图例 ─────────────────────────────────────────────── */}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-3 w-3 rounded bg-rose-600" />
                余量&lt;0 · 超卖需加房
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-3 w-3 rounded bg-amber-50 ring-1 ring-amber-300" />
                余量=0 · 售罄
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-3 w-3 rounded bg-amber-200 ring-1 ring-amber-400" />
                未配包房 · 该晚无包房周期，数字仅供参考
              </span>
              <span>点击任意「余量」格可查看当晚占房订单明细</span>
            </div>
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
                  {forward.remaining.map((v, i) => {
                    const held = forward.held[i];
                    const occupied = forward.occupied[i];
                    const unconfigured = held === 0 && occupied > 0;
                    return (
                      <td key={i} className={`px-2 py-1 text-right ${remainingCellCls(v, held, occupied)}`}>
                        {unconfigured ? '未配' : v}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── 包房周期管理 ─────────────────────────────────────────── */}
      <BlockPeriodsEditor token={token} onChanged={() => setBoardNonce((n) => n + 1)} />

      {/* ── 占房下钻抽屉（点击销控矩阵余量格弹出）──────────────────── */}
      {drill && (
        <OccupantsDrawer
          token={token}
          hotelId={drill.hotelId}
          hotelName={drill.hotelName}
          date={drill.date}
          block={drill.block}
          used={drill.used}
          onClose={() => setDrill(null)}
          onChanged={() => setBoardNonce((n) => n + 1)}
        />
      )}
    </div>
  );
}

// ── 占房下钻抽屉（GET /hotel-control/occupants；销控矩阵余量格点击用）───────
function OccupantsDrawer({
  token,
  hotelId,
  hotelName,
  date,
  block,
  used,
  onClose,
  onChanged,
}: {
  token: string;
  hotelId: string;
  hotelName: string;
  date: string;
  block: number;
  used: number;
  onClose: () => void;
  /** 换酒店成功后通知父级（触发销控板重拉）。 */
  onChanged?: () => void;
}) {
  const [occupants, setOccupants] = useState<HotelOccupant[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // 正在换酒店的占房行（null = 未打开换酒店弹窗）
  const [swapTarget, setSwapTarget] = useState<HotelOccupant | null>(null);

  const loadOccupants = useCallback(() => {
    if (!token) return;
    setErr(null);
    hotelControlOpsApi
      .getHotelOccupants(token, { hotelId, date })
      .then((r) => setOccupants(r.occupants))
      .catch((e: unknown) => setErr(e instanceof ApiError ? e.message : '占房订单加载失败'));
  }, [token, hotelId, date]);

  useEffect(() => {
    setOccupants(null);
    loadOccupants();
  }, [loadOccupants]);

  function handleCopy(orderId: string, orderNumber: string): void {
    copyOrderNumber(orderNumber);
    setCopiedId(orderId);
    setTimeout(() => setCopiedId((cur) => (cur === orderId ? null : cur)), 1500);
  }

  // 面板头部说明：区分「未配包房」与「真超卖/正常已占」两类语义，绝不混为一谈
  const headerNote =
    block === 0
      ? used > 0
        ? `该晚未配置包房周期 · 已占 ${used} 间（先补配包房，再考虑挪单）`
        : '该晚未配置包房周期 · 暂无占房'
      : used > block
        ? `包房 ${block} 间 · 超占 ${used - block} 间`
        : `包房 ${block} 间 · 已占 ${used} 间`;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-md flex-col overflow-y-auto bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-start justify-between gap-2 border-b border-slate-200 bg-white px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-ink">
              {hotelName} · {date}
            </h3>
            <p className="mt-1 text-xs text-ink-muted">{headerNote}</p>
          </div>
          <button type="button" className="text-slate-400 hover:text-slate-700" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="flex-1 p-4">
          {err ? (
            <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>
          ) : occupants == null ? (
            <div className="text-sm text-ink-muted">加载中…</div>
          ) : occupants.length === 0 ? (
            <div className="py-6 text-center text-sm text-ink-muted">该晚无占房订单</div>
          ) : (
            <ul className="space-y-2">
              {occupants.map((o, i) => (
                <li
                  key={`${o.orderId}-${i}`}
                  className="rounded-lg border border-slate-200 p-3 text-sm shadow-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono font-medium text-ink">{o.orderNumber}</span>
                    <span className="badge-neutral">{OCCUPANT_STATUS_LABEL[o.status] ?? o.status}</span>
                  </div>
                  <div className="mt-1 text-ink-soft">
                    {o.contactName} · {o.passengerCount} 人 · {o.rooms} 间
                  </div>
                  {o.passengerNames.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {o.passengerNames.map((name, ni) => (
                        <span key={`${o.orderId}-p${ni}`} className="badge-neutral text-xs">
                          {name}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-1.5 text-xs text-ink-muted">该订单暂无出行人信息</div>
                  )}
                  <div className="mt-1.5 text-xs text-ink-muted">
                    {o.checkIn} ~ {o.checkOut} · {o.agentName}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      className="btn-secondary px-2 py-1 text-xs"
                      onClick={() => handleCopy(o.orderId, o.orderNumber)}
                    >
                      {copiedId === o.orderId ? '已复制 ✓' : '复制订单号'}
                    </button>
                    <button
                      type="button"
                      className="text-xs font-medium text-brand hover:text-brand-dark"
                      onClick={() => setSwapTarget(o)}
                    >
                      换酒店
                    </button>
                    <Link to="/orders" className="text-xs text-brand hover:text-brand-dark">
                      去订单页 →
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {swapTarget && (
        <HotelSwapModal
          orderId={swapTarget.orderId}
          locateHint={{ hotelId, checkIn: swapTarget.checkIn, checkOut: swapTarget.checkOut }}
          onClose={() => setSwapTarget(null)}
          onSwapped={() => {
            setSwapTarget(null);
            loadOccupants(); // 抽屉：刷新占房列表
            onChanged?.(); // 板：通知父级重拉销控板
          }}
        />
      )}
    </div>
  );
}

// ── 房态导出（GET /hotel-control/export；销控矩阵原样导出，含「未配包房」标记）───
// 同卡片内附「导出护照」：选一家酒店 + 入住日期区间，打包该期间入住客人护照图 zip
// （GET /hotel-control/passports.zip；按订单分文件夹，缺图乘客写进 README）。
function BoardExport({ token, board }: { token: string; board: HotelControlBoard | null }) {
  const [exportFrom, setExportFrom] = useState<string>(todayStr());
  const [exportTo, setExportTo] = useState<string>(plusDaysStr(30));
  const [exporting, setExporting] = useState(false);

  async function handleExport(): Promise<void> {
    if (!token) return;
    setExporting(true);
    try {
      const blob = await hotelControlOpsApi.downloadBoardExport(token, { from: exportFrom, to: exportTo });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `房控导出-${exportFrom}_${exportTo}.xlsx`;
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

  // ── 导出护照 ──
  const hotelOptions = board?.hotels ?? [];
  const [passportHotelId, setPassportHotelId] = useState<string>('');
  const [passportFrom, setPassportFrom] = useState<string>(todayStr());
  const [passportTo, setPassportTo] = useState<string>(plusDaysStr(30));
  const [passporting, setPassporting] = useState(false);

  async function handlePassportExport(): Promise<void> {
    if (!token || !passportHotelId) return;
    setPassporting(true);
    try {
      const blob = await hotelControlOpsApi.downloadHotelPassportsZip(token, {
        hotelId: passportHotelId,
        from: passportFrom,
        to: passportTo,
      });
      const hotelName = hotelOptions.find((h) => h.hotelId === passportHotelId)?.hotelName ?? passportHotelId;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `护照-${hotelName}-${passportFrom}_${passportTo}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: unknown) {
      alert(e instanceof ApiError ? `导出失败：${e.message}` : '导出失败');
    } finally {
      setPassporting(false);
    }
  }

  const passportRangeInvalid = passportFrom > passportTo;

  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">导出房态（销控矩阵）</h2>
          <p className="mt-1 text-xs text-ink-muted">
            xlsx：每家酒店 包房/用房/物理房间/余量 四行 × 日期列，与本页矩阵一致（最长 120 天，含「未配包房」标记）。
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <label className="label">起始</label>
            <input
              type="date"
              className="input"
              value={exportFrom}
              onChange={(e) => setExportFrom(e.target.value)}
            />
          </div>
          <div>
            <label className="label">截止</label>
            <input type="date" className="input" value={exportTo} onChange={(e) => setExportTo(e.target.value)} />
          </div>
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={exporting || exportFrom > exportTo}
            className="btn-primary"
          >
            {exporting ? '导出中…' : '导出房态'}
          </button>
        </div>
      </div>
      {exportFrom > exportTo && <div className="text-xs text-amber-700">起始不能晚于截止</div>}

      {/* 导出护照：选酒店 + 入住日期区间 → 打包该期间入住客人护照图 zip */}
      <div className="border-t border-slate-200 pt-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">导出护照（按酒店）</h2>
            <p className="mt-1 text-xs text-ink-muted">
              zip：选一家酒店 + 入住日期区间，打包该期间所有入住客人的护照图，按订单号分文件夹；缺护照图的客人会列进 README.txt。
            </p>
          </div>
          <div className="flex items-end gap-2">
            <div>
              <label className="label">酒店</label>
              <select
                className="input"
                value={passportHotelId}
                onChange={(e) => setPassportHotelId(e.target.value)}
              >
                <option value="">请选择酒店</option>
                {hotelOptions.map((h) => (
                  <option key={h.hotelId} value={h.hotelId}>
                    {h.hotelName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">入住起</label>
              <input
                type="date"
                className="input"
                value={passportFrom}
                onChange={(e) => setPassportFrom(e.target.value)}
              />
            </div>
            <div>
              <label className="label">入住止</label>
              <input
                type="date"
                className="input"
                value={passportTo}
                onChange={(e) => setPassportTo(e.target.value)}
              />
            </div>
            <button
              type="button"
              onClick={() => void handlePassportExport()}
              disabled={passporting || !passportHotelId || passportRangeInvalid}
              className="btn-primary"
            >
              {passporting ? '导出中…' : '导出护照'}
            </button>
          </div>
        </div>
        {passportRangeInvalid && <div className="mt-2 text-xs text-amber-700">入住起不能晚于入住止</div>}
        {hotelOptions.length === 0 && (
          <div className="mt-2 text-xs text-ink-muted">当前查询范围内暂无酒店，调整上方销控板日期范围后再选。</div>
        )}
      </div>
    </section>
  );
}

// ── 订单分房（按订单号查 → 拖拽分房）────────────────────────────────────────
/**
 * 订单要显示的酒店中文名。
 * 优先取后端联查落的 item.hotelName（HOTEL 行或 BUNDLE 行盖章的 hotelRoomTypeId 均可命中，
 * 套餐订单没有独立 HOTEL 行时也能取到——否则套餐订单的分房弹窗酒店头会是空的）。
 * 回退到订单 HOTEL 行：description 形如「酒店名 · 房型 · 入住~退房 · N晚 × M间」，取 ' · ' 前段。
 * 再回退到已存分房组里带的 hotelName（老订单可能只在分房表里留了酒店名）。
 * 都取不到返回 undefined（分房编辑器优雅降级为不显示酒店头）。
 */
function hotelNameFromOrder(order: OrderSummary | null): string | undefined {
  if (!order) return undefined;
  const items = (order.items ?? []) as Array<{ hotelName?: string | null; kind?: string; description?: string }>;
  const fromHotelName = items.find((it) => it.hotelName)?.hotelName?.trim();
  if (fromHotelName) return fromHotelName;
  const hotelItem = order.items?.find((it) => it.kind === 'HOTEL');
  const fromItem = hotelItem?.description.split(' · ')[0]?.trim();
  if (fromItem) return fromItem;
  const fromGroup = order.roomAssignment?.roomGroups?.find((g) => g.hotelName)?.hotelName?.trim();
  return fromGroup || undefined;
}

/** 分房弹窗当日余房徽标要用的入住区间——从订单行取 hotelCheckIn/hotelCheckOut（同上取酒店名的行）。 */
function hotelStayFromOrder(order: OrderSummary | null): { checkIn: string; checkOut: string } | null {
  if (!order) return null;
  const items = (order.items ?? []) as Array<{
    hotelCheckIn?: string | null;
    hotelCheckOut?: string | null;
    kind?: string;
    hotelName?: string | null;
  }>;
  const hotelItem = items.find(
    (it) => (it.hotelName || it.kind === 'HOTEL') && it.hotelCheckIn && it.hotelCheckOut,
  );
  if (!hotelItem?.hotelCheckIn || !hotelItem?.hotelCheckOut) return null;
  // 后端 serializeOrder 原样透出 Prisma DateTime，序列化后是完整 ISO 串（2026-07-10T00:00:00.000Z）；
  // 本页销控板日期与 nextDayStr 都只认 YYYY-MM-DD，不归一会让 nextDayStr 拼出 Invalid Date
  // 并在 toISOString 处抛 "Invalid time value" 崩整页。
  return { checkIn: hotelItem.hotelCheckIn.slice(0, 10), checkOut: hotelItem.hotelCheckOut.slice(0, 10) };
}

/**
 * 从已加载的销控板本地切出某酒店在 [checkIn, checkOut) 内的逐晚余量（零额外请求，见
 * RoomingEditor.tsx nightlyRemaining 属性的 JSDoc）。该酒店不在当前 board.hotels（当前浏览的
 * from~to 范围内该酒店既无周期也无占房）、或入住区间有任意一晚超出 board.dates 覆盖范围
 * → 返回 null（宁可不显示徽标，不拿不完整数据拼凑误导）。
 */
function sliceBoardRemaining(
  board: HotelControlBoard | null,
  hotelId: string | undefined,
  checkIn: string | undefined,
  checkOut: string | undefined,
): HotelNightlyRemainingResult | null {
  if (!board || !hotelId || !checkIn || !checkOut || checkIn >= checkOut) return null;
  const hotel = board.hotels.find((h) => h.hotelId === hotelId);
  if (!hotel) return null;

  const nights: string[] = [];
  const MAX_NIGHTS = 60; // 安全上限，防止异常数据死循环
  for (let d = checkIn; d < checkOut && nights.length < MAX_NIGHTS; d = nextDayStr(d)) {
    nights.push(d);
  }
  if (nights.length === 0) return null;

  const idxByDate = new Map(board.dates.map((d, i) => [d, i]));
  if (!nights.every((n) => idxByDate.has(n))) return null;

  const remaining = nights.map((n) => hotel.rows.remaining[idxByDate.get(n)!]);
  const block = nights.map((n) => hotel.rows.block[idxByDate.get(n)!]);
  return { dates: nights, remaining, block, hasBlock: true };
}

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

function RoomingSection({ token, board }: { token: string; board: HotelControlBoard | null }) {
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
  // 分房要显示的酒店中文名：优先取订单 HOTEL 行（description 形如「酒店名 · 房型 · 入住~退房 · N晚 × M间」，
  // 取 ' · ' 前段作酒店名），回退到已存分房组里带的 hotelName。这样新订单未存分房时也能显示真实酒店名，
  // 不再落到「N人同酒店」这类占位。
  const seedHotelName = hotelNameFromOrder(order);
  const stay = hotelStayFromOrder(order);
  // 按酒店名在已加载的销控板里反查 hotelId（board 本身没有按名索引，订单也不直接带 hotelId）
  const hotelId = useMemo(
    () => (seedHotelName ? board?.hotels.find((h) => h.hotelName === seedHotelName)?.hotelId : undefined),
    [board, seedHotelName],
  );
  // 当日余房徽标数据：复用本页已拉的销控板本地切片，零额外请求（见 sliceBoardRemaining JSDoc）
  const nightlyRemaining = useMemo(
    () => sliceBoardRemaining(board, hotelId, stay?.checkIn, stay?.checkOut),
    [board, hotelId, stay?.checkIn, stay?.checkOut],
  );

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
                hotelId={hotelId}
                checkIn={stay?.checkIn}
                checkOut={stay?.checkOut}
                nightlyRemaining={nightlyRemaining}
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

/**
 * 拼房落单临近提醒 — 后端 alerts 新增（附加字段，向后兼容）。
 * api.ts 的 HotelControlAlerts 尚未声明该列，这里按可选读取，缺省即降级不显示。
 */
type SharedOddNear = Array<{
  hotelId: string;
  hotelName: string;
  date: string;
  sharedHalfCount: number;
}>;
function readSharedOddNear(alerts: unknown): SharedOddNear {
  const a = alerts as { sharedOddNear?: SharedOddNear };
  return Array.isArray(a.sharedOddNear) ? a.sharedOddNear : [];
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

  const sharedOddNear = alerts ? readSharedOddNear(alerts) : [];
  const total = alerts
    ? alerts.oversold.length +
      alerts.surplusSoon.length +
      alerts.overCapacitySchedules.length +
      sharedOddNear.length
    : 0;

  return (
    <section className="card">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          提醒线（超卖加房 / 富余退房 / 班次超开票上限 / 拼房落单）
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
              {sharedOddNear.map((a, i) => (
                <div
                  key={`so-${i}`}
                  className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700"
                >
                  <span className="font-semibold">拼房落单 ⚠</span> {a.hotelName}{' '}
                  {fmtMonthDay(a.date)} 有 {a.sharedHalfCount} 位拼房客（奇数）临近出发仍未配对 ·
                  补单房差或另配
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
// 两种口径：按「入住区间」选入住日；或按「出发日」选该日出发的订单、导出其整段入住晚。
function RoomAllocationExport({ token }: { token: string }) {
  const [mode, setMode] = useState<'range' | 'depart'>('range');
  const [exportFrom, setExportFrom] = useState<string>(todayStr());
  const [exportTo, setExportTo] = useState<string>(todayStr());
  const [departDate, setDepartDate] = useState<string>(todayStr());
  const [exporting, setExporting] = useState(false);

  const rangeInvalid = exportFrom > exportTo;

  async function handleExport(): Promise<void> {
    if (!token) return;
    setExporting(true);
    try {
      const params =
        mode === 'depart' ? { departDate } : { from: exportFrom, to: exportTo };
      const blob = await api.downloadRoomAllocation(token, params);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        mode === 'depart' ? `分房表-出发${departDate}.xlsx` : `分房表-${exportFrom}.xlsx`;
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
            {mode === 'depart'
              ? '按出发日：选该日出发的订单，导出其整段入住晚（每入住日一个 sheet）。'
              : '成都格式 xlsx：每入住日期一个 sheet，按酒店分组（区间最长 14 天）。'}
          </p>
          <div className="mt-2 flex gap-3 text-xs">
            <label className="inline-flex items-center gap-1">
              <input
                type="radio"
                name="room-alloc-mode"
                checked={mode === 'range'}
                onChange={() => setMode('range')}
              />
              按入住区间
            </label>
            <label className="inline-flex items-center gap-1">
              <input
                type="radio"
                name="room-alloc-mode"
                checked={mode === 'depart'}
                onChange={() => setMode('depart')}
              />
              按出发日
            </label>
          </div>
        </div>
        <div className="flex items-end gap-2">
          {mode === 'depart' ? (
            <div>
              <label className="label">出发日</label>
              <input
                type="date"
                className="input"
                value={departDate}
                onChange={(e) => setDepartDate(e.target.value)}
              />
            </div>
          ) : (
            <>
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
            </>
          )}
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={exporting || (mode === 'depart' ? !departDate : rangeInvalid)}
            className="btn-primary"
          >
            {exporting ? '导出中…' : '导出分房表'}
          </button>
        </div>
      </div>
      {mode === 'range' && rangeInvalid && (
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
