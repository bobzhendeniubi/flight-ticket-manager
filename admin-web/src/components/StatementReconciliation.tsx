/**
 * 流水认款工作台（分房式拖拽配对）—— 收款对账台「流水认款」页签。
 *
 * 交互与分房编辑器（RoomingEditor）同款心智：
 *   - 左侧 = 未认款流水池（OPEN / 部分认款的进账，可拖、可点选）。
 *   - 右侧 = 待收款订单盒子（尾款 > 0 的近期订单），把流水拖进订单 = 认款。
 *   - 拖到订单（或选中流水后点订单上的「认款到此单」）→ 行内确认金额 → 原子认领。
 *   - 选中/拖动流水时，金额与尾款吻合的订单亮「金额吻合」绿框，一眼看到该放哪。
 *   - 顶部「认款建议」：由服务端匹配引擎（POST /receipts/match/suggest）给出，按置信度分档：
 *       HIGH   = 金额精确 + 身份线索（备注订单号/姓名/代理/手机尾号）+ 双向唯一 → 可勾选批量 / 单条一键认款；
 *       MEDIUM / LOW = 只展示候选 + 理由标签，点「选中并定位」后走拖拽/点选的常规认款路径；
 *       组合建议（多笔凑一单 / 一笔付多单）单独一块，MEDIUM 的可按组合确认后批量认款，LOW 只展示。
 *     不管哪一档，入账都走既有 allocate / allocate-batch 接口——建议只是建议，钱的闸门在服务端不变。
 *
 * 流水导入：上传收单平台 xlsx → 解析预览（可导入/重复/非成功/无效 分色）→ 确认入池。
 * 重复导入天然幂等：交易流水号唯一索引，已认过的行状态不丢。
 * 导出核对表：原流水 + 认款状态/认到订单/认款人，替代财务线下勾表。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  ApiError,
  PAYMENT_METHOD_LABEL,
  RECEIPT_SOURCE_LABEL,
  type PaymentMethod,
  type Receipt,
  type ReceiptMatchCandidate,
  type ReceiptMatchCombo,
  type ReceiptMatchComboReason,
  type ReceiptMatchConfidence,
  type ReceiptMatchSuggestion,
  type ReceiptMatchSuggestResult,
  type StatementDisposition,
  type StatementPlatform,
  type StatementPreviewResult,
} from '../lib/api';
import { formatInBusinessTz } from '../lib/datetime';
import { NumberInput } from './NumberInput';
import { Icon } from './Icon';
import { useConfirm } from './ConfirmDialog';
import { useDialogA11y } from './Modal';

// 金额相等判定容差（分位以下视为相等）
const AMOUNT_EPS = 0.005;

function fmtCny(n: number): string {
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 到账时刻，固定北京时间（原先用 getHours 等取浏览器时区，境外看会跟导出差几小时）。 */
function fmtDateTime(iso: string): string {
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

/** 方式徽标（微=绿 / 支=蓝 / 其它=灰），工作台密集展示用单字。 */
function methodBadge(method: PaymentMethod): { text: string; cls: string } {
  switch (method) {
    case 'WECHAT_PAY':
      return { text: '微', cls: 'bg-emerald-100 text-emerald-700' };
    case 'ALIPAY':
      return { text: '支', cls: 'bg-sky-100 text-sky-700' };
    default:
      return { text: '卡', cls: 'bg-slate-100 text-slate-600' };
  }
}

const DISPOSITION_META: Record<StatementDisposition, { label: string; cls: string }> = {
  ok: { label: '可导入', cls: 'bg-emerald-50 text-emerald-700' },
  dup_in_db: { label: '已在系统', cls: 'bg-sky-50 text-sky-700' },
  dup_in_file: { label: '文件内重复', cls: 'bg-amber-50 text-amber-700' },
  skipped_status: { label: '非支付成功', cls: 'bg-slate-100 text-slate-500' },
  skipped_type: { label: '非收款/消费类型', cls: 'bg-slate-100 text-slate-500' },
  invalid: { label: '无法解析', cls: 'bg-rose-50 text-rose-700' },
};

/** 建议理由标签（服务端 reason 码 → 财务看得懂的短语） */
const REASON_LABEL: Record<ReceiptMatchComboReason, string> = {
  AMOUNT_EXACT: '金额吻合',
  AMOUNT_PARTIAL: '部分付款',
  AMOUNT_COVERS: '金额大于尾款',
  REMARK_HAS_ORDER_NO: '备注含订单号',
  ORDER_HINT: '自报订单',
  REMARK_HAS_PASSENGER_NAME: '备注含姓名',
  PAYER_MATCHES_AGENT: '付款人=代理',
  PHONE_TAIL: '手机尾号吻合',
  DATE_NEAR: '时间邻近',
  AMOUNT_SUM_EXACT: '合计吻合',
  SAME_PAYER: '同付款人',
  SAME_AGENT: '同代理',
  SAME_CONTACT: '同联系人',
  SAME_DAY: '同一天',
};

const CONFIDENCE_META: Record<
  ReceiptMatchConfidence,
  { label: string; badge: string; box: string; hint: string }
> = {
  HIGH: {
    label: '高',
    badge: 'badge-success',
    box: 'border-emerald-200 bg-emerald-50/50',
    hint: '金额精确 + 身份线索 + 唯一对应。核对无误可勾选批量认款。',
  },
  MEDIUM: {
    label: '中',
    badge: 'badge-warning',
    box: 'border-amber-200 bg-amber-50/40',
    hint: '金额吻合但缺身份线索、或线索强但只是部分付款。请点「选中并定位」后拖到订单确认。',
  },
  LOW: {
    label: '低',
    badge: 'badge-neutral',
    box: 'border-slate-200 bg-slate-50/60',
    hint: '线索较弱，仅供参考。',
  },
};

const COMBO_TYPE_LABEL: Record<ReceiptMatchCombo['type'], string> = {
  MANY_RECEIPTS_ONE_ORDER: '多笔凑一单',
  ONE_RECEIPT_MANY_ORDERS: '一笔付多单',
};

/** 认款目标订单的最小引用（建议里的订单不一定在右栏候选列表里） */
interface OrderRef {
  orderId: string;
  orderNumber: string;
  contactName: string;
}

const STATEMENT_PLATFORM_OPTIONS: Array<{
  value: StatementPlatform;
  label: string;
  /** 平台特殊说明（如导出模板要求），选项下方小字展示 */
  note?: string;
}> = [
  { value: 'CMB_QR', label: '招行二维码' },
  { value: 'YISHOUBAO', label: '宜收宝' },
  { value: 'XINGYIFU', label: '星驿付' },
  { value: 'HUISHENGHUO', label: '会生活', note: '请用逐笔明细模板导出（按日汇总表不支持）' },
];

interface StatementReconciliationProps {
  token: string;
  /** 认款/导入成功后回调——父页面（对账台）借此刷新 KPI 条，避免顶部数字停留在操作前 */
  onMutated?: () => void;
}

export function StatementReconciliation({ token, onMutated }: StatementReconciliationProps) {
  const askConfirm = useConfirm();
  const allocationConfirmRef = useRef(false);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [candidates, setCandidates] = useState<ReceiptMatchCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 选中/拖动中的流水（点选与拖拽共用一套高亮逻辑）
  const [activeReceiptId, setActiveReceiptId] = useState<string | null>(null);
  // 正在确认认款的订单（行内金额确认面板）
  const [confirmTarget, setConfirmTarget] = useState<{ orderId: string; receiptId: string } | null>(
    null,
  );
  const [onlyImported, setOnlyImported] = useState(false);
  const [orderQuery, setOrderQuery] = useState('');
  // 流水池筛选（传后端）：到账日期闭区间 + 关键词（进账号/流水号/付款备注/订单提示）
  const [poolFrom, setPoolFrom] = useState('');
  const [poolTo, setPoolTo] = useState('');
  const [poolQ, setPoolQ] = useState('');
  // 订单栏筛选（传后端）：下单日期闭区间（关键词复用 orderQuery，服务端过滤）
  const [orderFrom, setOrderFrom] = useState('');
  const [orderTo, setOrderTo] = useState('');
  // 批量认款：勾选的建议组（按 receipt.id 唯一标识，一笔流水在建议里至多出现一次）
  const [selectedSug, setSelectedSug] = useState<Set<string>>(new Set());
  // 认款请求进行中（防连点：双击「确认认款/一键认款/批量认款」会重复入账）
  const [allocating, setAllocating] = useState(false);
  // 服务端认款建议（随池子重载刷新；加载失败不影响工作台本身，只在建议区提示）
  const [suggest, setSuggest] = useState<ReceiptMatchSuggestResult | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestErr, setSuggestErr] = useState<string | null>(null);

  // 导入流程
  const [preview, setPreview] = useState<StatementPreviewResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [platformPickerOpen, setPlatformPickerOpen] = useState(false);
  const [platformChoice, setPlatformChoice] = useState<StatementPlatform | null>(null);
  const [statementPlatform, setStatementPlatform] = useState<StatementPlatform | null>(null);
  const statementPlatformRef = useRef<StatementPlatform | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 导出
  const [exportFrom, setExportFrom] = useState('');
  const [exportTo, setExportTo] = useState('');
  const [exporting, setExporting] = useState(false);

  // 加载守卫：这是资金操作面板，改筛选后**晚到的旧响应绝不能覆盖新结果**——
  // 否则运营会把流水拖到一张已经被筛掉的候选单上认款，钱认错单。
  // load 返回 cancel 函数，由调用方（防抖 effect 的 cleanup）在发起下一次加载前调用。
  const load = useCallback(() => {
    if (!token) return () => {};
    let cancelled = false;
    setLoading(true);
    setErr(null);
    const orderQ = orderQuery.trim();
    // unallocatedOnly：服务端只回未认完的池子，不会被已认款记录挤掉旧 OPEN 流水
    Promise.all([
      api.listReceipts(token, {
        unallocatedOnly: '1',
        ...(poolQ.trim() ? { q: poolQ.trim() } : {}),
        ...(poolFrom ? { from: poolFrom } : {}),
        ...(poolTo ? { to: poolTo } : {}),
      }),
      // 订单关键词/日期传后端过滤：跨全量候选搜索，不再受「近 400 单」窗口限制
      api.getReceiptMatchCandidates(token, {
        ...(orderQ ? { q: orderQ } : {}),
        ...(orderFrom ? { from: orderFrom } : {}),
        ...(orderTo ? { to: orderTo } : {}),
      }),
    ])
      .then(([r, c]) => {
        if (cancelled) return;
        setReceipts(r.receipts);
        setCandidates(c.orders);
        // 建议：把当前池子里未认完的流水 id 交给服务端算（与池子筛选同步；服务端自己拉 90 天候选单）。
        // 不等建议回来就先把工作台画出来——建议是锦上添花，拖拽认款不依赖它。
        setSelectedSug(new Set());
        setSuggestErr(null);
        const ids = r.receipts
          .filter((x) => x.status === 'OPEN' || x.status === 'PARTIALLY_ALLOCATED')
          .map((x) => x.id);
        if (ids.length === 0) {
          setSuggest(null);
          setSuggestLoading(false);
          return;
        }
        setSuggestLoading(true);
        api
          .suggestReceiptMatches(token, { receiptIds: ids })
          .then((s) => {
            if (!cancelled) setSuggest(s);
          })
          .catch((e: unknown) => {
            if (cancelled) return;
            setSuggest(null);
            setSuggestErr(e instanceof ApiError ? e.message : '认款建议加载失败');
          })
          .finally(() => {
            if (!cancelled) setSuggestLoading(false);
          });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setErr(e instanceof ApiError ? e.message : '加载工作台数据失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, poolQ, poolFrom, poolTo, orderQuery, orderFrom, orderTo]);

  // 防抖：筛选输入停 300ms 再打后端，避免每敲一个字都发请求。
  // cleanup 里既清定时器、也作废已在飞的那次请求（筛选连续变化时前一次必被作废）。
  useEffect(() => {
    let cancelLoad: (() => void) | undefined;
    const t = setTimeout(() => {
      cancelLoad = load();
    }, 300);
    return () => {
      clearTimeout(t);
      cancelLoad?.();
    };
  }, [load]);

  // 完整未认款池（服务端已按 OPEN/部分认款过滤）——自动配对唯一性必须基于它计算
  const openPool = useMemo(
    () => receipts.filter((r) => r.status === 'OPEN' || r.status === 'PARTIALLY_ALLOCATED'),
    [receipts],
  );
  // 展示池：可选只看流水导入（仅影响左栏展示，不影响配对唯一性结论）
  const pool = useMemo(
    () => openPool.filter((r) => !onlyImported || r.source === 'STATEMENT_IMPORT'),
    [openPool, onlyImported],
  );

  const activeReceipt = useMemo(
    () => (activeReceiptId ? pool.find((r) => r.id === activeReceiptId) ?? null : null),
    [pool, activeReceiptId],
  );

  // 订单过滤（客户端：订单号 / 联系人 / 代理名）
  const filteredOrders = useMemo(() => {
    const q = orderQuery.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (o) =>
        o.orderNumber.toLowerCase().includes(q) ||
        o.contactName.toLowerCase().includes(q) ||
        (o.agentName ?? '').toLowerCase().includes(q),
    );
  }, [candidates, orderQuery]);

  // 服务端建议按「该流水最佳候选的置信度」分组。HIGH 组每笔恰好一张候选（引擎保证双向唯一）。
  // 只保留仍在当前未认款池里的流水——建议是上一次池子快照算的，认掉/筛掉的不再展示。
  const grouped = useMemo(() => {
    const inPool = new Set(openPool.map((r) => r.id));
    const high: ReceiptMatchSuggestion[] = [];
    const medium: ReceiptMatchSuggestion[] = [];
    const low: ReceiptMatchSuggestion[] = [];
    for (const s of suggest?.receipts ?? []) {
      const top = s.candidates[0];
      if (!top || !inPool.has(s.receiptId)) continue;
      if (top.confidence === 'HIGH') high.push(s);
      else if (top.confidence === 'MEDIUM') medium.push(s);
      else low.push(s);
    }
    const combos = (suggest?.combos ?? []).filter((c) =>
      c.parts.every((p) => inPool.has(p.receiptId)),
    );
    return { high, medium, low, combos };
  }, [suggest, openPool]);

  // 勾选中的 HIGH 组数（只算当前有效建议里被勾的，重载后失效的旧勾选不计入）
  const selectedCount = useMemo(
    () => grouped.high.filter((s) => selectedSug.has(s.receiptId)).length,
    [grouped.high, selectedSug],
  );

  // ── 认款（拖放 / 点选 / HIGH 建议一键 共用入口；in-flight 期间拒绝二次提交）──
  // order 传引用而非 id：建议里的订单来自服务端 90 天窗口，不一定在右栏候选列表里。
  async function allocate(receiptId: string, order: OrderRef, amount: number): Promise<void> {
    if (allocating || allocationConfirmRef.current) return;
    const receipt = openPool.find((r) => r.id === receiptId);
    if (!receipt) return;
    allocationConfirmRef.current = true;
    const ok = await askConfirm({
      title: '确认认款？',
      body: `确认把流水 ${fmtCny(amount)}（${receipt.externalTxnId ? `流水号…${receipt.externalTxnId.slice(-8)}` : receipt.receiptNo}）认款到订单 ${order.orderNumber} · ${order.contactName}？`,
      tone: 'danger',
    });
    if (!ok) {
      allocationConfirmRef.current = false;
      return;
    }
    setErr(null);
    setNotice(null);
    setAllocating(true);
    try {
      await api.allocateReceipt(token, receiptId, { orderId: order.orderId, amountCny: amount });
      setNotice(`已认款：${fmtCny(amount)} → ${order.orderNumber} · ${order.contactName}`);
      setActiveReceiptId(null);
      setConfirmTarget(null);
      load();
      onMutated?.();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '认款失败');
    } finally {
      setAllocating(false);
      allocationConfirmRef.current = false;
    }
  }

  // ── 批量认款（只有 HIGH 组可勾选；复用 allocate-batch，逐组独立事务）──────────
  function toggleSug(receiptId: string): void {
    setSelectedSug((prev) => {
      const next = new Set(prev);
      if (next.has(receiptId)) next.delete(receiptId);
      else next.add(receiptId);
      return next;
    });
  }

  function toggleSelectAll(): void {
    setSelectedSug((prev) =>
      prev.size === grouped.high.length && grouped.high.length > 0
        ? new Set()
        : new Set(grouped.high.map((s) => s.receiptId)),
    );
  }

  /** 批量认款的共用收口：复用 allocate-batch，逐组回结果，成败分开提示。 */
  async function runAllocateBatch(
    items: Array<{ receiptId: string; orderId: string; amountCny: number }>,
    confirm: { title: string; body: React.ReactNode },
    failLabel: string,
  ): Promise<void> {
    if (allocating || allocationConfirmRef.current || items.length === 0) return;
    allocationConfirmRef.current = true;
    const ok = await askConfirm({ ...confirm, tone: 'danger' });
    if (!ok) {
      allocationConfirmRef.current = false;
      return;
    }
    setErr(null);
    setNotice(null);
    setAllocating(true);
    try {
      const res = await api.allocateReceiptBatch(token, items);
      const { succeeded, failed } = res.summary;
      setNotice(`${failLabel}完成：成功 ${succeeded} 组${failed > 0 ? `，失败 ${failed} 组` : ''}`);
      if (failed > 0) {
        const firstFail = res.results.find((r) => !r.ok);
        if (firstFail && !firstFail.ok) setErr(`有 ${failed} 组未成功，例如：${firstFail.error}`);
      }
      setSelectedSug(new Set());
      setActiveReceiptId(null);
      setConfirmTarget(null);
      load();
      onMutated?.();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : `${failLabel}失败`);
    } finally {
      setAllocating(false);
      allocationConfirmRef.current = false;
    }
  }

  /** HIGH 组勾选批量：每笔认到它唯一的 HIGH 候选，金额 = 服务端建议额（min(流水余额, 尾款)）。 */
  function runBatch(): Promise<void> {
    // 只认「当前建议里且被勾选」的组——过滤掉重载后已失效的旧勾选
    const chosen = grouped.high.filter((s) => selectedSug.has(s.receiptId));
    return runAllocateBatch(
      chosen.map((s) => ({
        receiptId: s.receiptId,
        orderId: s.candidates[0].orderId,
        amountCny: s.candidates[0].suggestedAmountCny,
      })),
      {
        title: '确认批量认款？',
        body: `确认批量认款 ${chosen.length} 组？每组把流水按建议金额认款到高置信度候选订单（金额精确 + 身份线索 + 唯一对应）。`,
      },
      '批量认款',
    );
  }

  /** 组合建议按组执行（仅 MEDIUM 组合开放）：确认框逐条列出每一笔怎么认。 */
  function runCombo(combo: ReceiptMatchCombo): Promise<void> {
    return runAllocateBatch(
      combo.parts.map((p) => ({ receiptId: p.receiptId, orderId: p.orderId, amountCny: p.amountCny })),
      {
        title: `确认按「${COMBO_TYPE_LABEL[combo.type]}」认款？`,
        body: (
          <div className="space-y-1 text-sm">
            <div>共 {combo.parts.length} 条，合计 {fmtCny(combo.totalCny)}：</div>
            <ul className="list-disc space-y-0.5 pl-5 text-xs">
              {combo.parts.map((p) => (
                <li key={`${p.receiptId}-${p.orderId}`}>
                  {fmtCny(p.amountCny)}（{p.externalTxnId ? `流水号…${p.externalTxnId.slice(-8)}` : p.receiptNo}）
                  → {p.orderNumber} · {p.contactName}
                </li>
              ))}
            </ul>
            <div className="text-xs text-ink-muted">逐条独立入账，某条失败不影响其它条；请先核对每一笔。</div>
          </div>
        ),
      },
      '组合认款',
    );
  }

  /** MEDIUM / LOW 建议：选中这笔流水并把订单号填进右栏筛选，让财务沿常规拖拽/点选路径确认。 */
  function locate(receiptId: string, orderNumber: string): void {
    setActiveReceiptId(receiptId);
    setConfirmTarget(null);
    setOrderQuery(orderNumber);
  }

  function handleDropToOrder(orderId: string, e: React.DragEvent): void {
    e.preventDefault();
    const receiptId = e.dataTransfer.getData('text/plain') || activeReceiptId;
    if (receiptId) {
      setActiveReceiptId(receiptId);
      setConfirmTarget({ orderId, receiptId });
    }
  }

  // ── 导入 ───────────────────────────────────────────────────────────────
  function openPlatformPicker(): void {
    if (parsing) return;
    setPlatformChoice(null);
    setPlatformPickerOpen(true);
  }

  function pickStatementFile(): void {
    if (!platformChoice) return;
    statementPlatformRef.current = platformChoice;
    setStatementPlatform(platformChoice);
    setPlatformPickerOpen(false);
    fileInputRef.current?.click();
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const f = e.target.files?.[0];
    e.target.value = ''; // 允许再次选择同一文件
    if (!f) return;
    const platform = statementPlatformRef.current ?? statementPlatform;
    if (!platform) {
      setErr('请先选择流水平台');
      return;
    }
    setParsing(true);
    setErr(null);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        const base64 = dataUrl.split(',')[1] ?? '';
        const result = await api.parseReceiptStatement(token, platform, base64);
        setPreview(result);
      } catch (err2: unknown) {
        setErr(err2 instanceof ApiError ? err2.message : '流水解析失败');
      } finally {
        setParsing(false);
      }
    };
    reader.onerror = () => {
      setErr('读取文件失败');
      setParsing(false);
    };
    reader.readAsDataURL(f);
  }

  async function confirmImport(): Promise<void> {
    if (!preview || !statementPlatform || importing) return;
    const rows = preview.rows
      .filter((r) => r.disposition === 'ok')
      .map((r) => ({
        externalTxnId: r.externalTxnId,
        amountCny: r.amountCny as number,
        method: r.method,
        receivedAt: r.receivedAt as string,
        ...(r.payerNote ? { payerNote: r.payerNote } : {}),
      }));
    if (rows.length === 0) {
      setPreview(null);
      return;
    }
    setImporting(true);
    setErr(null);
    try {
      const result = await api.importReceiptStatement(token, statementPlatform, rows);
      setNotice(
        `流水导入完成：入池 ${result.imported} 笔${result.skipped > 0 ? `，跳过 ${result.skipped} 笔（已存在）` : ''}`,
      );
      setPreview(null);
      load();
      onMutated?.();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '流水导入失败');
    } finally {
      setImporting(false);
    }
  }

  // ── 导出 ───────────────────────────────────────────────────────────────
  async function doExport(): Promise<void> {
    if (exporting) return;
    setExporting(true);
    setErr(null);
    try {
      const blob = await api.exportReceiptStatement(token, {
        ...(exportFrom ? { from: exportFrom } : {}),
        ...(exportTo ? { to: exportTo } : {}),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `流水核对表${exportFrom ? `-${exportFrom}` : ''}${exportTo ? `~${exportTo}` : ''}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '导出失败');
    } finally {
      setExporting(false);
    }
  }

  // ── 流水 chip ──────────────────────────────────────────────────────────
  function ReceiptChip({ r }: { r: Receipt }) {
    const remaining = Number(r.remainingCny);
    const selected = r.id === activeReceiptId;
    const mb = methodBadge(r.method);
    const isPartial = r.status === 'PARTIALLY_ALLOCATED';
    return (
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', r.id);
          e.dataTransfer.effectAllowed = 'move';
          setActiveReceiptId(r.id);
        }}
        onClick={() => setActiveReceiptId(selected ? null : r.id)}
        className={`cursor-grab select-none rounded-lg border bg-white p-2 shadow-sm transition active:cursor-grabbing ${
          selected
            ? 'border-brand ring-2 ring-brand/30'
            : 'border-slate-200 hover:border-brand/40 hover:bg-brand-50/40'
        }`}
        title={[
          r.externalTxnId ? `流水号 ${r.externalTxnId}` : `进账号 ${r.receiptNo}`,
          r.payerNote ? `备注：${r.payerNote}` : null,
          '拖到右侧订单认款，或点选后点订单上的「认款到此单」',
        ]
          .filter(Boolean)
          .join('\n')}
      >
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-flex h-5 w-5 items-center justify-center rounded text-xs font-medium ${mb.cls}`}
          >
            {mb.text}
          </span>
          <span className="nums text-sm font-semibold text-ink">{fmtCny(remaining)}</span>
          {isPartial && <span className="badge-info text-[10px]">部分</span>}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-muted">
          <span>{fmtDateTime(r.receivedAt)}</span>
          {r.externalTxnId ? (
            <span className="font-mono">…{r.externalTxnId.slice(-8)}</span>
          ) : (
            <span className="badge-neutral text-[10px]">{RECEIPT_SOURCE_LABEL[r.source]}</span>
          )}
        </div>
      </div>
    );
  }

  // ── 订单盒子 ───────────────────────────────────────────────────────────
  function OrderBox({ o }: { o: ReceiptMatchCandidate }) {
    const activeRemaining = activeReceipt ? Number(activeReceipt.remainingCny) : null;
    const amountMatch =
      activeRemaining != null && Math.abs(activeRemaining - o.balanceDue) < AMOUNT_EPS;
    const confirming = confirmTarget?.orderId === o.orderId;
    const confirmReceipt = confirming
      ? (pool.find((r) => r.id === confirmTarget?.receiptId) ?? null)
      : null;
    return (
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => handleDropToOrder(o.orderId, e)}
        className={`rounded-xl border bg-surface p-3 shadow-sm transition ${
          amountMatch
            ? 'border-emerald-400 ring-2 ring-emerald-200'
            : 'border-slate-200 hover:border-brand/30'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-medium text-ink">{o.orderNumber}</span>
            <span className="text-sm text-ink">{o.contactName}</span>
            <span className="text-xs text-ink-muted">
              出发 {o.departureDate ? o.departureDate.slice(5) : '—'}
            </span>
            {o.agentName && <span className="text-xs text-ink-muted">· {o.agentName}</span>}
            {amountMatch && <span className="badge-success text-[10px]">金额吻合</span>}
          </div>
          <div className="nums text-xs text-ink-soft">
            应收 {fmtCny(o.totalPayable)} · 已收 {fmtCny(o.paidAmount)} ·{' '}
            <b className="text-amber-700">尾款 {fmtCny(o.balanceDue)}</b>
          </div>
        </div>

        {activeReceipt && !confirming && (
          <button
            type="button"
            className={`mt-2 w-full rounded-lg border border-dashed px-2 py-1.5 text-xs transition ${
              amountMatch
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                : 'border-slate-300 text-ink-soft hover:bg-slate-50'
            }`}
            onClick={() => setConfirmTarget({ orderId: o.orderId, receiptId: activeReceipt.id })}
          >
            认款到此单（选中流水 {fmtCny(Number(activeReceipt.remainingCny))}）
          </button>
        )}

        {confirming && confirmReceipt && (
          <AllocateConfirmInline
            receipt={confirmReceipt}
            order={o}
            submitting={allocating}
            onConfirm={(amount) => void allocate(confirmReceipt.id, o, amount)}
            onCancel={() => setConfirmTarget(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 工具条 */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <button
            type="button"
            className={`btn-primary inline-flex items-center gap-1.5 text-sm ${parsing ? 'pointer-events-none opacity-60' : ''}`}
            onClick={openPlatformPicker}
            disabled={parsing}
          >
            <Icon name="file" /> {parsing ? '解析中…' : '导入二维码流水'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={onPickFile}
            disabled={parsing}
          />
          <label className="inline-flex items-center gap-1.5 text-xs text-ink-soft">
            <input
              type="checkbox"
              checked={onlyImported}
              onChange={(e) => setOnlyImported(e.target.checked)}
            />
            只看流水导入
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-1.5">
          <label className="text-xs text-ink-soft">
            从
            <input
              type="date"
              className="input ml-1 w-36 py-1 text-xs"
              value={exportFrom}
              onChange={(e) => setExportFrom(e.target.value)}
            />
          </label>
          <label className="text-xs text-ink-soft">
            到
            <input
              type="date"
              className="input ml-1 w-36 py-1 text-xs"
              value={exportTo}
              onChange={(e) => setExportTo(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn-secondary text-sm disabled:opacity-50"
            onClick={() => void doExport()}
            disabled={exporting}
          >
            ⬇ {exporting ? '导出中…' : '导出核对表'}
          </button>
        </div>
      </div>

      {err && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <Icon name="check" /> {notice}
        </div>
      )}

      {/* 认款建议（服务端匹配引擎）：HIGH 可勾选批量；MEDIUM / LOW 只展示 + 选中定位；组合单独一块 */}
      {(suggestLoading || suggestErr || suggest) && openPool.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              认款建议
              {suggest && (
                <span className="ml-2 normal-case tracking-normal text-ink-muted">
                  高 {grouped.high.length} · 中 {grouped.medium.length} · 低 {grouped.low.length} · 组合{' '}
                  {grouped.combos.length}
                  <span className="ml-2">
                    （候选单回看近 {suggest.scanned.sinceDays} 天，待收 {suggest.scanned.unpaidOrders} 单）
                  </span>
                </span>
              )}
            </span>
            {suggestLoading && <span className="text-xs text-ink-muted">建议计算中…</span>}
          </div>
          {suggestErr && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {suggestErr}（不影响手动拖拽认款）
            </div>
          )}

          {/* HIGH：可勾选批量认款 / 单条一键认款 */}
          {grouped.high.length > 0 && (
            <div className={`rounded-xl border p-3 ${CONFIDENCE_META.HIGH.box}`}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-1.5 text-xs font-medium text-emerald-800">
                  <input
                    type="checkbox"
                    checked={selectedCount === grouped.high.length && grouped.high.length > 0}
                    ref={(el) => {
                      if (el) el.indeterminate = selectedCount > 0 && selectedCount < grouped.high.length;
                    }}
                    onChange={toggleSelectAll}
                  />
                  <span className={CONFIDENCE_META.HIGH.badge}>高置信度</span>
                  {grouped.high.length} 笔 · {CONFIDENCE_META.HIGH.hint}
                </label>
                <button
                  type="button"
                  className="btn-primary px-3 py-1 text-xs disabled:opacity-50"
                  disabled={allocating || selectedCount === 0}
                  onClick={() => void runBatch()}
                >
                  {allocating ? '认款中…' : `批量认款${selectedCount > 0 ? ` ${selectedCount} 组` : ''}`}
                </button>
              </div>
              <div className="space-y-1.5">
                {grouped.high.map((s) => {
                  const c = s.candidates[0];
                  return (
                    <div
                      key={s.receiptId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-3 py-1.5 text-sm shadow-sm"
                    >
                      <label className="flex min-w-0 flex-wrap items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedSug.has(s.receiptId)}
                          onChange={() => toggleSug(s.receiptId)}
                        />
                        <SuggestionReceiptLabel s={s} />
                        <span className="text-ink-muted">→</span>
                        <span className="font-mono text-xs">{c.orderNumber}</span>
                        <span>{c.contactName}</span>
                        {c.agentName && <span className="text-xs text-ink-muted">· {c.agentName}</span>}
                        <span className="nums text-xs text-ink-soft">尾款 {fmtCny(c.balanceDue)}</span>
                        <ReasonTags reasons={c.reasons} />
                      </label>
                      <button
                        type="button"
                        className="btn-secondary px-2.5 py-1 text-xs disabled:opacity-50"
                        disabled={allocating}
                        onClick={() => void allocate(s.receiptId, c, c.suggestedAmountCny)}
                      >
                        {allocating ? '认款中…' : `一键认款 ${fmtCny(c.suggestedAmountCny)}`}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* MEDIUM / LOW：只展示候选 + 理由；「选中并定位」后走拖拽/点选常规路径 */}
          {(['MEDIUM', 'LOW'] as const).map((level) => {
            const list = level === 'MEDIUM' ? grouped.medium : grouped.low;
            if (list.length === 0) return null;
            const meta = CONFIDENCE_META[level];
            return (
              <details key={level} className={`rounded-xl border p-3 ${meta.box}`} open={level === 'MEDIUM'}>
                <summary className="cursor-pointer text-xs font-medium text-ink">
                  <span className={meta.badge}>{meta.label}置信度</span>
                  <span className="ml-1.5">{list.length} 笔</span>
                  <span className="ml-2 font-normal text-ink-muted">{meta.hint}</span>
                </summary>
                <div className="mt-2 space-y-1.5">
                  {list.map((s) => (
                    <div key={s.receiptId} className="rounded-lg bg-white px-3 py-1.5 text-sm shadow-sm">
                      <SuggestionReceiptLabel s={s} />
                      <div className="mt-1 space-y-1">
                        {s.candidates.map((c) => (
                          <div
                            key={c.orderId}
                            className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-1 text-xs"
                          >
                            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                              <span className={CONFIDENCE_META[c.confidence].badge}>
                                {CONFIDENCE_META[c.confidence].label}
                              </span>
                              <span className="font-mono">{c.orderNumber}</span>
                              <span className="text-ink">{c.contactName}</span>
                              {c.agentName && <span className="text-ink-muted">· {c.agentName}</span>}
                              <span className="nums text-ink-soft">
                                尾款 {fmtCny(c.balanceDue)} · 建议认 {fmtCny(c.suggestedAmountCny)}
                              </span>
                              <ReasonTags reasons={c.reasons} />
                            </span>
                            <button
                              type="button"
                              className="btn-ghost px-2 py-0.5 text-xs"
                              onClick={() => locate(s.receiptId, c.orderNumber)}
                              title="选中这笔流水，并把该订单筛到右栏；再拖过去或点「认款到此单」确认"
                            >
                              选中并定位 →
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            );
          })}

          {/* 组合建议：多笔凑一单 / 一笔付多单 */}
          {grouped.combos.length > 0 && (
            <details className="rounded-xl border border-sky-200 bg-sky-50/40 p-3" open>
              <summary className="cursor-pointer text-xs font-medium text-ink">
                <span className="badge-info">组合建议</span>
                <span className="ml-1.5">{grouped.combos.length} 组</span>
                <span className="ml-2 font-normal text-ink-muted">
                  多笔凑一单 / 一笔付多单，合计金额精确相等。中置信度的可按组合确认后批量认款；低置信度只供参考。
                </span>
              </summary>
              <div className="mt-2 space-y-1.5">
                {grouped.combos.map((combo) => {
                  const key = `${combo.type}:${combo.parts.map((p) => `${p.receiptId}>${p.orderId}`).join('|')}`;
                  return (
                    <div key={key} className="rounded-lg bg-white px-3 py-1.5 text-sm shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex flex-wrap items-center gap-1.5 text-xs">
                          <span className={CONFIDENCE_META[combo.confidence].badge}>
                            {CONFIDENCE_META[combo.confidence].label}
                          </span>
                          <b>{COMBO_TYPE_LABEL[combo.type]}</b>
                          <span className="nums">合计 {fmtCny(combo.totalCny)}</span>
                          <ReasonTags reasons={combo.reasons} />
                        </span>
                        {combo.confidence === 'MEDIUM' ? (
                          <button
                            type="button"
                            className="btn-secondary px-2.5 py-1 text-xs disabled:opacity-50"
                            disabled={allocating}
                            onClick={() => void runCombo(combo)}
                          >
                            {allocating ? '认款中…' : `按此组合认款（${combo.parts.length} 条）`}
                          </button>
                        ) : (
                          <span className="text-[11px] text-ink-muted">仅供参考，请手动逐笔拖拽</span>
                        )}
                      </div>
                      <ul className="mt-1 space-y-0.5 text-xs text-ink-soft">
                        {combo.parts.map((p) => (
                          <li key={`${p.receiptId}-${p.orderId}`} className="flex flex-wrap items-center gap-1.5">
                            <span className="nums font-medium text-ink">{fmtCny(p.amountCny)}</span>
                            <span className="font-mono text-ink-muted">
                              {p.externalTxnId ? `…${p.externalTxnId.slice(-8)}` : p.receiptNo}
                            </span>
                            <span className="text-ink-muted">→</span>
                            <span className="font-mono">{p.orderNumber}</span>
                            <span>{p.contactName}</span>
                            {p.agentName && <span className="text-ink-muted">· {p.agentName}</span>}
                            <span className="nums text-ink-muted">（尾款 {fmtCny(p.orderBalanceDue)}）</span>
                            <button
                              type="button"
                              className="btn-ghost px-1.5 py-0 text-[11px]"
                              onClick={() => locate(p.receiptId, p.orderNumber)}
                            >
                              定位
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </details>
          )}

          {suggest &&
            !suggestLoading &&
            grouped.high.length + grouped.medium.length + grouped.low.length + grouped.combos.length === 0 && (
              <div className="rounded-lg border border-dashed border-slate-300 px-3 py-2 text-xs text-ink-muted">
                当前池子里的流水没有找到可靠的候选订单（金额与备注都对不上），请手动拖拽认款。
              </div>
            )}
        </div>
      )}

      {/* 分房式双栏：左流水池 / 右订单盒子 */}
      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              未认款流水
            </span>
            <span className="badge-warning">{pool.length}</span>
          </div>
          {/* 流水池筛选（传后端）：关键词 + 到账日期区间 */}
          <div className="mb-2 space-y-1.5">
            <input
              className="input w-full py-1.5 text-xs"
              placeholder="筛：进账号 / 流水号 / 付款备注"
              value={poolQ}
              onChange={(e) => setPoolQ(e.target.value)}
            />
            <div className="flex items-center gap-1 text-[11px] text-ink-muted">
              <input
                type="date"
                className="input min-w-0 flex-1 py-1 text-xs"
                value={poolFrom}
                onChange={(e) => setPoolFrom(e.target.value)}
                aria-label="到账日期从"
              />
              <span>~</span>
              <input
                type="date"
                className="input min-w-0 flex-1 py-1 text-xs"
                value={poolTo}
                onChange={(e) => setPoolTo(e.target.value)}
                aria-label="到账日期到"
              />
            </div>
          </div>
          {loading ? (
            <div className="py-8 text-center text-xs text-ink-muted">加载中…</div>
          ) : pool.length === 0 ? (
            <div className="flex items-center justify-center gap-1 py-8 text-center text-xs text-ink-muted">池子空了 · 全部认完 <Icon name="check" /></div>
          ) : (
            <div className="grid max-h-[36rem] gap-1.5 overflow-y-auto pr-1">
              {pool.map((r) => (
                <ReceiptChip key={r.id} r={r} />
              ))}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              待收款订单（尾款 &gt; 0）
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {/* 下单日期区间（传后端，按订单 createdAt） */}
              <input
                type="date"
                className="input w-36 py-1.5 text-xs"
                value={orderFrom}
                onChange={(e) => setOrderFrom(e.target.value)}
                aria-label="下单日期从"
              />
              <span className="text-[11px] text-ink-muted">~</span>
              <input
                type="date"
                className="input w-36 py-1.5 text-xs"
                value={orderTo}
                onChange={(e) => setOrderTo(e.target.value)}
                aria-label="下单日期到"
              />
              <input
                className="input w-56 py-1.5 text-sm"
                placeholder="筛：订单号 / 联系人 / 代理"
                value={orderQuery}
                onChange={(e) => setOrderQuery(e.target.value)}
              />
            </div>
          </div>
          {loading ? (
            <div className="py-8 text-center text-xs text-ink-muted">加载中…</div>
          ) : filteredOrders.length === 0 ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-6 text-center text-xs text-ink-muted">
              {orderQuery
                ? '没有匹配的待收款订单；更早的订单请在「待认领」页签按订单号认领'
                : '暂无待收款订单'}
            </div>
          ) : (
            <div className="grid max-h-[36rem] gap-2 overflow-y-auto pr-1">
              {filteredOrders.map((o) => (
                <OrderBox key={o.orderId} o={o} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 导入预览弹窗 */}
      {platformPickerOpen && (
        <StatementPlatformPickerModal
          value={platformChoice}
          onChange={setPlatformChoice}
          onChooseFile={pickStatementFile}
          onClose={() => setPlatformPickerOpen(false)}
        />
      )}
      {preview && (
        <ImportPreviewModal
          preview={preview}
          importing={importing}
          onConfirm={() => void confirmImport()}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

// ── 建议区小件 ───────────────────────────────────────────────────────────────
/** 理由标签串（服务端 reason 码 → 中文短语）。 */
function ReasonTags({ reasons }: { reasons: ReceiptMatchComboReason[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {reasons.map((r) => (
        <span key={r} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
          {REASON_LABEL[r] ?? r}
        </span>
      ))}
    </span>
  );
}

/** 建议行里的流水摘要：金额 · 时间 · 流水号尾 8 位 · 付款备注。 */
function SuggestionReceiptLabel({ s }: { s: ReceiptMatchSuggestion }) {
  const mb = methodBadge(s.method);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      <span className={`inline-flex h-5 w-5 items-center justify-center rounded text-xs font-medium ${mb.cls}`}>
        {mb.text}
      </span>
      <b className="nums">{fmtCny(Number(s.remainingCny))}</b>
      <span className="text-xs text-ink-muted">
        {fmtDateTime(s.receivedAt)}
        {s.externalTxnId && <span className="ml-1 font-mono">…{s.externalTxnId.slice(-8)}</span>}
      </span>
      {s.payerNote && (
        <span className="max-w-[16rem] truncate text-xs text-ink-soft" title={s.payerNote}>
          备注：{s.payerNote}
        </span>
      )}
    </span>
  );
}

// ── 行内认款金额确认（默认 = min(流水剩余, 订单尾款)）─────────────────────────
function AllocateConfirmInline({
  receipt,
  order,
  submitting,
  onConfirm,
  onCancel,
}: {
  receipt: Receipt;
  order: ReceiptMatchCandidate;
  submitting: boolean;
  onConfirm: (amount: number) => void;
  onCancel: () => void;
}) {
  const remaining = Number(receipt.remainingCny);
  const suggested = Math.min(remaining, order.balanceDue);
  const [amount, setAmount] = useState<number | null>(suggested > 0 ? suggested : null);
  const amt = amount ?? 0;
  const invalid = !Number.isFinite(amt) || amt <= 0 || amt > remaining + AMOUNT_EPS;
  return (
    <div className="mt-2 rounded-lg border border-brand/30 bg-brand-50/50 p-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-ink-soft">
          认款金额（流水剩余 {fmtCny(remaining)} · 订单尾款 {fmtCny(order.balanceDue)}）
          <NumberInput
            step={0.01}
            min={0}
            max={remaining}
            className="input mt-1 w-32 py-1.5 nums"
            value={amount}
            onChange={(n) => setAmount(n)}
          />
        </label>
        <button
          type="button"
          className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
          disabled={invalid || submitting}
          onClick={() => onConfirm(Math.round(amt * 100) / 100)}
        >
          {submitting ? '认款中…' : '确认认款'}
        </button>
        <button type="button" className="btn-ghost px-2.5 py-1.5 text-xs" onClick={onCancel}>
          取消
        </button>
      </div>
      {remaining > order.balanceDue + AMOUNT_EPS && (
        <div className="mt-1 text-[11px] text-amber-700">
          流水大于尾款：默认只认尾款部分，余下留在池子里继续认给其他订单。
        </div>
      )}
    </div>
  );
}

function StatementPlatformPickerModal({
  value,
  onChange,
  onChooseFile,
  onClose,
}: {
  value: StatementPlatform | null;
  onChange: (value: StatementPlatform) => void;
  onChooseFile: () => void;
  onClose: () => void;
}) {
  const dialogRef = useDialogA11y(onClose);
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="选择流水平台" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/40 animate-fade-in" onClick={onClose} aria-hidden />
      <div className="relative z-10 w-full max-w-md rounded-xl bg-surface p-5 shadow-pop">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink">选择流水平台</h2>
            <p className="mt-1 text-xs text-ink-muted">请选择平台后，再选择对应的流水文件。</p>
          </div>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-lg text-ink-muted hover:bg-slate-100 hover:text-ink"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
        <div className="mt-4 space-y-2">
          {STATEMENT_PLATFORM_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition ${
                value === option.value
                  ? 'border-brand bg-brand-50 text-brand-700'
                  : 'border-slate-200 text-ink hover:border-brand/40'
              }`}
            >
              <input
                type="radio"
                name="statement-platform"
                checked={value === option.value}
                onChange={() => onChange(option.value)}
              />
              <span className="flex flex-col">
                <span>{option.label}</span>
                {option.note && (
                  <span className="text-[11px] text-ink-muted">{option.note}</span>
                )}
              </span>
            </label>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary text-sm" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary text-sm disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onChooseFile}
            disabled={!value}
          >
            选择文件
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 导入预览弹窗 ─────────────────────────────────────────────────────────────
function ImportPreviewModal({
  preview,
  importing,
  onConfirm,
  onClose,
}: {
  preview: StatementPreviewResult;
  importing: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { summary } = preview;
  const dialogRef = useDialogA11y(onClose);
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="流水导入预览" tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/40 animate-fade-in" onClick={onClose} aria-hidden />
      <div className="relative z-10 flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl bg-surface p-5 shadow-pop">
        <div className="flex items-start justify-between">
          <h2 className="text-base font-semibold text-ink">流水导入预览</h2>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-lg text-ink-muted hover:bg-slate-100 hover:text-ink"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <span className="badge-success">可导入 {summary.importable}</span>
          <span className="badge-info">已在系统 {summary.dupInDb}</span>
          {summary.dupInFile > 0 && (
            <span className="badge-warning">文件内重复 {summary.dupInFile}</span>
          )}
          <span className="badge-neutral">非成功状态 {summary.skippedStatus}</span>
          {summary.skippedType > 0 && (
            <span className="badge-neutral">非收款/消费类型 {summary.skippedType}</span>
          )}
          {summary.invalid > 0 && <span className="badge-danger">无法解析 {summary.invalid}</span>}
          <span className="text-ink-muted">共 {summary.total} 行</span>
        </div>

        {preview.warnings.length > 0 && (
          <div className="mt-2 max-h-20 overflow-y-auto rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
            {preview.warnings.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </div>
        )}

        <div className="mt-3 min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200">
          <table className="table-admin text-xs">
            <thead>
              <tr>
                <th>行</th>
                <th>交易流水号</th>
                <th>时间</th>
                <th className="text-right">金额</th>
                <th>方式</th>
                <th>平台状态</th>
                <th>处置</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((r) => {
                const meta = DISPOSITION_META[r.disposition];
                return (
                  <tr key={r.rowNumber} className={r.disposition === 'ok' ? '' : 'opacity-70'}>
                    <td className="text-ink-muted">{r.rowNumber}</td>
                    <td className="font-mono">{r.externalTxnId || '—'}</td>
                    <td className="whitespace-nowrap">
                      {r.receivedAt ? fmtDateTime(r.receivedAt) : '—'}
                    </td>
                    <td className="nums text-right">
                      {r.amountCny != null ? fmtCny(r.amountCny) : '—'}
                    </td>
                    <td>{PAYMENT_METHOD_LABEL[r.method] ?? r.rawMethod}</td>
                    <td>{r.rawStatus || '—'}</td>
                    <td>
                      <span className={`rounded px-1.5 py-0.5 ${meta.cls}`}>
                        {meta.label}
                        {r.existing && (
                          <span className="ml-1 text-[10px]">
                            （{r.existing.receiptNo.slice(0, 11)}…）
                          </span>
                        )}
                      </span>
                      {r.existing?.amountMismatch && (
                        <span
                          className="ml-1 rounded bg-rose-50 px-1.5 py-0.5 text-rose-700"
                          title="同一交易流水号，但金额与系统里已存在的进账不一致——请人工核对是平台改单还是表格被改过"
                        >
                          <Icon name="alert" /> 金额冲突（库 ¥{Number(r.existing.amountCny).toFixed(2)}）
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <div className="text-xs text-ink-muted">
            重复导入不怕：同一交易流水号只会入池一次，已认款的行状态不会丢。
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary text-sm"
              onClick={onClose}
              disabled={importing}
            >
              取消
            </button>
            <button
              type="button"
              className="btn-primary text-sm disabled:opacity-50"
              onClick={onConfirm}
              disabled={importing || summary.importable === 0}
            >
              {importing ? '导入中…' : `导入 ${summary.importable} 笔`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
