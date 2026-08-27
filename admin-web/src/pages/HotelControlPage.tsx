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
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { formatInBusinessTz } from '../lib/datetime';
import {
  api,
  ApiError,
  hotelControlOpsApi,
  type RandomStarTier,
  type BlockPeriodWriteInput,
  type HotelBlockPeriod,
  type HotelControlAlerts,
  type HotelControlBoard,
  type HotelControlForward,
  type HotelRecentRoomChanges,
  type HotelNightlyRemainingResult,
  type HotelOccupant,
  type OrderSummary,
  type RoomGroup,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { NumberInput } from '../components/NumberInput';
import { RoomingEditor, type RoomingPassenger } from '../components/RoomingEditor';
import { HotelSwapModal } from '../components/HotelSwapModal';
import { useConfirm } from '../components/ConfirmDialog';
import { useDialogA11y } from '../components/Modal';

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
/** 按姓名批量导出：把textarea原始输入按 逗号/顿号/空格/换行 拆成姓名列表，trim + 去空 + 去重。 */
function parseNamesInput(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[,，、\s]+/u)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
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
  TICKETED: '出票完成',
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
 * 异性不能拼一间：physicalUsed = ceil(男/2) + ceil(女/2) + 未知 + 整间预订数；
 * 落单数 sharedUnpaired = 男%2 + 女%2 + 未知（同性配对后余数 + 未知全算落单）。
 */
type SharedRows = {
  sharedHalfCount?: number[];
  sharedUnpaired?: number[];
  sharedOdd?: boolean[];
  physicalUsed?: number[];
  physicalRemaining?: number[];
};
function readShared(rows: unknown): SharedRows {
  const r = rows as SharedRows;
  return {
    sharedHalfCount: r.sharedHalfCount,
    sharedUnpaired: r.sharedUnpaired,
    sharedOdd: r.sharedOdd,
    physicalUsed: r.physicalUsed,
    physicalRemaining: r.physicalRemaining,
  };
}

// 矩阵 sticky 列宽：第一列（酒店）11rem，第二列（行标签）3.5rem
const STICKY_COL1 = 'sticky left-0 z-10 min-w-[11rem] bg-white';
const STICKY_COL2 = 'sticky left-[11rem] z-10 min-w-[3.5rem] bg-white';

// ── 星级随机档（三星随机 / 四星随机 / 五星随机）───────────────────────────────
/**
 * 随机档**不是**单独切的库存，而是同星级酒店库存的派生聚合：
 *   随机N星余量 = Σ(同星级酒店余量) − 未落位占用
 * 所以页面里没有「建随机档周期」这回事（后端也拒建），它只在销控矩阵/远期里作为一个
 * 聚合分组出现。判定一律看 `randomStarTier` 非空 —— 聚合组的 hotelId 是后端合成键，
 * 不能当酒店 id 用。
 *
 * 「未落位占用」还包含仍挂在随机档**占位酒店**（Hotel.randomTierPlaceholder 非空，早期
 * 用假酒店承载随机档留下的形态）房型上的订单行。占位酒店不作为酒店组出现在销控矩阵里，
 * 名下的切房周期在下面的周期列表里打「已停用」灰标（后端下发 period.disabled）。
 */

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
  // 余量格点击下钻（某酒店/某星级随机池某晚，谁占的）；null = 抽屉关闭
  const [drill, setDrill] = useState<{
    hotelId: string;
    hotelName: string;
    /** 非空 = 池组下钻（此时 hotelId 是合成键，不能当酒店 id 传给接口） */
    randomStarTier: RandomStarTier | null;
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
      <RecentChangesPanel token={token} />

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
          每家酒店四行：包房 / 用房（床位口径）/ 物理房间 / 余量（床位口径 = 包房 − 用房）。横向滚动看更多日期（最长 120 天）。用房格出现
          <span className="mx-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-amber-100 px-1 text-[10px] font-semibold leading-none text-amber-700 ring-1 ring-amber-300">拼</span>
          表示当晚有拼房客无法配对（异性不能拼一间、性别未知按每人独占），需补单房差或另行配对。
          「用房」与「余量」为床位口径（拼房客各计 0.5，故余量可出现 .5，如 13.5）；「物理房间」是实际占用的整间数（同性两位拼 1 间、落单或未知各独占 1 间），只作展示，不参与余量判定。
          「三星随机 / 四星随机」是同星级酒店的合计（= Σ 同星级酒店余量 − 未落位随机单），不是单独一份库存。
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
                        <div className="font-medium text-ink">
                          {h.hotelName}
                          {/* 聚合组：同星级酒店的合计视图，不是一家酒店，用角标点明 */}
                          {h.randomStarTier != null && (
                            <span
                              className="ml-1.5 inline-flex items-center rounded-full bg-indigo-50 px-1.5 text-[10px] font-semibold leading-4 text-indigo-700 ring-1 ring-indigo-200"
                              title="同星级酒店合计：包房 = 同星级各酒店包房之和；用房 = 尚未落到具体酒店的随机单；余量 = 同星级各酒店余量之和 − 未落位随机单（故本行「包房 − 用房」不等于「余量」）"
                            >
                              合计
                            </span>
                          )}
                        </div>
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
                        const total = shared.sharedHalfCount?.[i] ?? 0;
                        const unpaired = shared.sharedUnpaired?.[i] ?? 0;
                        const tip = `本日 ${total} 位拼房客，其中 ${unpaired} 位无法配对（异性不能拼一间、性别未知按每人独占）——需补单房差或另行配对`;
                        return (
                          <td key={i} className="px-2 py-1 text-right text-ink-soft">
                            <span className="inline-flex items-center gap-1">
                              {v}
                              {odd && (
                                <span
                                  className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-amber-100 px-1 text-[10px] font-semibold leading-none text-amber-700 ring-1 ring-amber-300"
                                  title={tip}
                                  aria-label={tip}
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
                      {h.rows.remaining.map((bedRem, i) => {
                        const block = h.rows.block[i];
                        const used = h.rows.used[i];
                        const unconfigured = block === 0 && used > 0;
                        const date = board.dates[i];
                        return (
                          <td
                            key={i}
                            className={`cursor-pointer px-2 py-1 text-right transition hover:ring-1 hover:ring-brand/50 ${remainingCellCls(bedRem, block, used)}`}
                            title={
                              unconfigured
                                ? '未配包房：该晚无包房周期覆盖，此数字非真实超卖 · 点击查看占房订单'
                                : h.randomStarTier != null
                                  ? '同星级酒店余量之和 − 未落位随机单（床位口径）· 点击查看未落位的随机单'
                                  : '余量 = 包房 − 用房（床位口径，可出现 .5）· 点击查看占房订单'
                            }
                            onClick={() =>
                              setDrill({
                                hotelId: h.hotelId,
                                hotelName: h.hotelName,
                                randomStarTier: h.randomStarTier,
                                date,
                                block,
                                used,
                              })
                            }
                          >
                            {unconfigured ? '未配' : bedRem}
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
              <span className="basis-full">
                「三星随机 / 四星随机」= 同星级酒店合计：包房 = 同星级各酒店包房之和；用房 = 尚未落到具体酒店的随机单；余量 = 同星级各酒店余量之和 − 未落位随机单。
                把随机单落位到某家酒店后，该酒店用房 +1、未落位随机单 −1，随机档余量不变。
              </span>
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
          randomStarTier={drill.randomStarTier}
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
  randomStarTier,
  date,
  block,
  used,
  onClose,
  onChanged,
}: {
  token: string;
  hotelId: string;
  hotelName: string;
  /** 非空 = 星级随机池下钻（hotelId 是合成键，接口按 randomStarTier 查）。 */
  randomStarTier: RandomStarTier | null;
  date: string;
  block: number;
  used: number;
  onClose: () => void;
  /** 换酒店成功后通知父级（触发销控板重拉）。 */
  onChanged?: () => void;
}) {
  const dialogRef = useDialogA11y(onClose);
  const [occupants, setOccupants] = useState<HotelOccupant[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // 正在换酒店的占房行（null = 未打开换酒店弹窗）
  const [swapTarget, setSwapTarget] = useState<HotelOccupant | null>(null);

  const loadOccupants = useCallback(() => {
    if (!token) return;
    setErr(null);
    hotelControlOpsApi
      .getHotelOccupants(
        token,
        randomStarTier != null ? { randomStarTier, date } : { hotelId, date },
      )
      .then((r) => setOccupants(r.occupants))
      .catch((e: unknown) => setErr(e instanceof ApiError ? e.message : '占房订单加载失败'));
  }, [token, hotelId, randomStarTier, date]);

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
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="酒店控制详情" tabIndex={-1} className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose}>
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
          <button type="button" className="text-slate-400 hover:text-slate-700" onClick={onClose} aria-label="关闭酒店控制详情">
            <Icon name="close" />
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
                      {copiedId === o.orderId ? '已复制' : '复制订单号'}
                    </button>
                    <button
                      type="button"
                      className="text-xs font-medium text-brand hover:text-brand-dark"
                      onClick={() => setSwapTarget(o)}
                    >
                      {randomStarTier != null ? '落酒店' : '换酒店'}
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
          locateHint={{ hotelId, checkIn: swapTarget.checkIn, checkOut: swapTarget.checkOut, randomStarTier }}
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
  // 护照 zip 按真实酒店导出 —— 星级随机池是虚拟分组（hotelId 是合成键），排除在下拉之外
  const hotelOptions = (board?.hotels ?? []).filter((h) => h.randomStarTier == null);
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

  // ── 导出护照（按姓名，不限酒店；可选按出发日期过滤）──
  const [namesInput, setNamesInput] = useState<string>('');
  const [namesExporting, setNamesExporting] = useState(false);
  const [namesDepFrom, setNamesDepFrom] = useState<string>(''); // 出发起（留空=不限）
  const [namesDepTo, setNamesDepTo] = useState<string>(''); // 出发止（留空=不限）
  const parsedNames = useMemo(() => parseNamesInput(namesInput), [namesInput]);
  const namesTooMany = parsedNames.length > 100;
  const namesDepRangeInvalid = namesDepFrom !== '' && namesDepTo !== '' && namesDepFrom > namesDepTo;

  async function handlePassportByNamesExport(): Promise<void> {
    if (!token || parsedNames.length === 0 || namesTooMany || namesDepRangeInvalid) return;
    setNamesExporting(true);
    try {
      const blob = await hotelControlOpsApi.downloadHotelPassportsByNamesZip(token, {
        names: parsedNames,
        from: namesDepFrom || undefined,
        to: namesDepTo || undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const rangePart =
        namesDepFrom || namesDepTo ? `-出发${namesDepFrom || '不限'}至${namesDepTo || '不限'}` : '';
      a.download = `护照-按姓名-${parsedNames.length}人${rangePart}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: unknown) {
      alert(e instanceof ApiError ? `导出失败：${e.message}` : '导出失败');
    } finally {
      setNamesExporting(false);
    }
  }

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

      {/* 导出护照：按姓名批量导出（不限酒店；可选按出发日期过滤，zip 按出发日期分文件夹） */}
      <div className="border-t border-slate-200 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-[280px] flex-1">
            <h2 className="text-sm font-semibold text-ink">导出护照（按姓名）</h2>
            <p className="mt-1 text-xs text-ink-muted">
              不限酒店；可选按出发日期过滤（留空=不限），zip 按出发日期分文件夹、按姓名命名文件。姓名匹配：护照姓名不分大小写，或中文姓名精确匹配；逗号/顿号/空格/换行分隔均可，一次最多 100 个姓名。
            </p>
            <textarea
              className="input mt-2 w-full"
              rows={3}
              placeholder="张永亮，张永顺，孟令宝，陆敏"
              value={namesInput}
              onChange={(e) => setNamesInput(e.target.value)}
            />
            <div className={`mt-1 text-xs ${namesTooMany ? 'text-rose-700' : 'text-ink-muted'}`}>
              已识别 {parsedNames.length} 个姓名{namesTooMany && '（超过单次上限 100 个，请分批导出）'}
            </div>
          </div>
          <div className="flex items-end gap-2">
            <div>
              <label className="label">出发起</label>
              <input
                type="date"
                className="input"
                value={namesDepFrom}
                onChange={(e) => setNamesDepFrom(e.target.value)}
              />
            </div>
            <div>
              <label className="label">出发止</label>
              <input
                type="date"
                className="input"
                value={namesDepTo}
                onChange={(e) => setNamesDepTo(e.target.value)}
              />
            </div>
            <button
              type="button"
              onClick={() => void handlePassportByNamesExport()}
              disabled={namesExporting || parsedNames.length === 0 || namesTooMany || namesDepRangeInvalid}
              className="btn-primary"
            >
              {namesExporting ? '导出中…' : '导出护照(按姓名)'}
            </button>
          </div>
        </div>
        {namesDepRangeInvalid && <div className="mt-2 text-xs text-amber-700">出发起不能晚于出发止</div>}
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

// ── 近期用房变更面板（GET /hotel-control/recent-changes；读审计流，不做已读态）──
// 订单侧改了分房 / 换酒店 / 补收单房差 / 改期，房控看板会静默反映——这里给一条「变更发生过」的
// 可见性：默认收起，徽标示条数；点开列出 时间 / 订单号（可点跳订单）/ 操作人 / 变更摘要 /
// 乘客 / 出发返程日期 / 订单金额，方便房控核对是谁、哪天走、多少钱的单动了用房。
const RECENT_CHANGES_DAYS = 7;
/** 变更行乘客姓名展示上限——超过则截断为「前 N 个 + 等 M 人」。*/
const CHANGE_PASSENGER_NAMES_LIMIT = 3;

/** ISO8601 → 北京时间「M/D HH:mm」（原先用 getHours 等取浏览器时区，境外看会跟导出对不上）。*/
function fmtChangeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatInBusinessTz(d, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** "2026-08-10" → "8/10"（变更行紧凑日期，与提醒线 fmtMonthDay 同风格）。*/
function fmtChangeDate(date: string): string {
  const parts = date.split('-');
  if (parts.length !== 3) return date;
  const [, m, d] = parts;
  return `${Number(m)}/${Number(d)}`;
}

/** 乘客姓名列表 → 「张三、李四、王五 等 5 人」（超过展示上限才带「等 N 人」）。*/
function fmtChangePassengers(names: string[]): string {
  if (names.length === 0) return '—';
  const shown = names.slice(0, CHANGE_PASSENGER_NAMES_LIMIT).join('、');
  return names.length > CHANGE_PASSENGER_NAMES_LIMIT ? `${shown} 等 ${names.length} 人` : shown;
}

/** 出发/返程日 → "8/10–8/15"（单程/缺失时只显示出发日或「—」）。*/
function fmtChangeTrip(departDate: string | null, returnDate: string | null): string {
  if (!departDate) return '—';
  return returnDate ? `${fmtChangeDate(departDate)}–${fmtChangeDate(returnDate)}` : fmtChangeDate(departDate);
}

function RecentChangesPanel({ token }: { token: string }) {
  const [data, setData] = useState<HotelRecentRoomChanges | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .getHotelRecentChanges(token, RECENT_CHANGES_DAYS)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : '用房变更加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const count = data?.count ?? 0;
  const hasChanges = count > 0;

  return (
    <section className="card">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          近期用房变更
          <span className="text-xs font-normal text-ink-muted">
            （订单侧改分房 / 换酒店 / 补房差）
          </span>
          {data != null && (
            <span className={hasChanges ? 'badge-warning' : 'badge-neutral'}>
              近 {RECENT_CHANGES_DAYS} 天 {count} 条变更
            </span>
          )}
        </h2>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="btn-ghost px-2 py-1 text-xs"
          disabled={!hasChanges}
        >
          {open ? '收起 ▲' : '展开 ▼'}
        </button>
      </div>
      {err ? (
        <div className="mt-3 text-sm text-rose-600">{err}</div>
      ) : data == null ? (
        <div className="mt-3 text-sm text-ink-muted">加载用房变更…</div>
      ) : !hasChanges ? (
        <div className="mt-3 text-sm text-ink-muted">近 {RECENT_CHANGES_DAYS} 天暂无用房变更</div>
      ) : (
        open && (
          <ul className="mt-3 divide-y divide-slate-100">
            {data.changes.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2 text-sm">
                <span className="w-24 shrink-0 text-xs text-ink-muted nums">
                  {fmtChangeTime(c.at)}
                </span>
                <span className="badge-neutral shrink-0">{c.actionLabel}</span>
                {c.orderNumber ? (
                  <Link
                    to={`/orders?q=${encodeURIComponent(c.orderNumber)}`}
                    className="shrink-0 font-medium text-brand hover:text-brand-dark nums"
                  >
                    {c.orderNumber}
                  </Link>
                ) : (
                  <span className="shrink-0 text-ink-muted">—</span>
                )}
                <span
                  className="shrink-0 text-xs text-ink-muted"
                  title={c.passengerNames.join('、') || undefined}
                >
                  {fmtChangePassengers(c.passengerNames)}
                </span>
                <span className="shrink-0 text-xs text-ink-muted nums">
                  {fmtChangeTrip(c.departDate, c.returnDate)}
                </span>
                <span className="shrink-0 text-xs text-ink-muted nums">
                  {c.orderAmountCny != null ? fmtCny(c.orderAmountCny) : '—'}
                </span>
                <span className="text-ink-soft">{c.summary}</span>
                <span className="text-xs text-ink-muted">· {c.actor ?? '—'}</span>
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  );
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
                  <span className="inline-flex items-center gap-1 font-semibold"><Icon name="alert" /> 超卖</span> {a.hotelName} {fmtMonthDay(a.date)}{' '}
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
                  <span className="inline-flex items-center gap-1 font-semibold"><Icon name="alert" /> 票务</span> {a.flightNumber}{' '}
                  {fmtMonthDay(a.departureDate)} 已收客 {a.paxCount} 人 · 超过开票上限
                </div>
              ))}
              {sharedOddNear.map((a, i) => (
                <div
                  key={`so-${i}`}
                  className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700"
                >
                  <span className="inline-flex items-center gap-1 font-semibold"><Icon name="alert" /> 拼房落单</span> {a.hotelName}{' '}
                  {fmtMonthDay(a.date)} 有 {a.sharedHalfCount} 位拼房客临近出发仍未配对（异性不能拼一间）·
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
  const confirm = useConfirm();
  const confirmLockRef = useRef(false);
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
          // 随机档占位项不是真实酒店，给它切房 = 与同星级真酒店的库存双记一笔账（后端也拒建）
          .filter((h) => h.randomTierPlaceholder == null)
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
    if (confirmLockRef.current) return;
    confirmLockRef.current = true;
    if (!(await confirm({
      title: '确认删除该包房周期？',
      body: '删除后该酒店该日期段的「包房」会相应减少。',
      tone: 'danger',
    }))) {
      confirmLockRef.current = false;
      return;
    }
    try {
      await api.deleteBlockPeriod(token, id);
      load();
      onChanged();
    } catch (e: unknown) {
      alert(e instanceof ApiError ? e.message : '删除失败');
    } finally {
      confirmLockRef.current = false;
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
            星级随机档不用单独切房——它就是同星级各酒店包房的合计；标「已停用」的周期不计入任何余量，仅留作查账。
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
  // 下拉选中值 = 真实酒店 id。包房周期只能挂在具体酒店上 —— 「三星/四星随机」是同星级酒店
  // 的派生合计，不再单独切一份库存（后端 createBlockPeriod 也会拒），故此处没有随机档选项。
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
            「三星/四星随机」无需单独切房：它就是同星级各酒店余量的合计，按酒店切房即可。
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
        <td className="py-2 font-medium text-ink">
          {period.hotelName}
          {period.disabled && (
            <span
              className="ml-1.5 inline-flex items-center rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold leading-4 text-slate-500 ring-1 ring-slate-300"
              title={
                period.randomStarTier != null
                  ? '历史遗留的随机档周期：随机档已改为同星级酒店合计，这条周期不再计入任何余量，仅保留供查账；可直接删除'
                  : '这家是随机档的占位项，不是真实酒店：它的切房不计入任何余量（否则同一批房算两遍），仅保留供查账；可直接删除'
              }
            >
              已停用
            </span>
          )}
        </td>
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
            className="btn-ghost-danger px-2 py-1 text-xs"
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
