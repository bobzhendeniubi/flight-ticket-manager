/**
 * 导出中心 · 目录数据 + 角色过滤（纯函数，无 React / 无 DOM）
 *
 * 背景：全系统 18 个 xlsx/zip 导出端点散在订单 / 航班 / 房控 / 签证台 / 财务 / 收款六个模块里，
 * 运营要记 18 个入口，「功能早有只是没找到」是反馈里的常客。本文件把这 18 个导出集中登记成
 * 一张目录：名称、一句话口径说明、参数形态、可见角色、原按钮在哪儿。
 *
 * 纪律：
 *   · 说明文案一律抄自各页现有按钮旁的文案与后端 orders.export-*.ts / finances.export*.ts
 *     的文件头口径注释，**不自己编**；改口径时同步改那边和这里。
 *   · 本目录只描述「有哪些导出、谁能看见」，不发请求 —— 真正调 api.ts 的是 ExportCenterPage。
 *   · 各页原有的导出按钮**一个都不删**：这里是第二入口（能一次看全），不是唯一入口。
 */
import type { StaffRole, UserRole } from './api';

// ── 岗位分组 ──────────────────────────────────────────────────────────
export type ExportGroupKey =
  | 'intake'
  | 'ticketing'
  | 'visa'
  | 'hotel'
  | 'finance'
  | 'receipt'
  | 'report';

export interface ExportGroupMeta {
  key: ExportGroupKey;
  label: string;
  /** 分组小字：这一组是给谁用的 */
  hint: string;
}

/** 分组渲染顺序（与后台侧栏「运营 → 产品 → 财务」的阅读顺序同向）。 */
export const EXPORT_GROUPS: ExportGroupMeta[] = [
  { key: 'intake', label: '录单', hint: '收单、整理名单要用的模版' },
  { key: 'ticketing', label: '票务', hint: '整班名单、航司提交、进单与控位' },
  { key: 'visa', label: '签证', hint: '送签名单与护照资料（需先勾人）' },
  { key: 'hotel', label: '房控', hint: '分房表与房态销控' },
  { key: 'finance', label: '财务', hint: '成本毛利核对（财务岗可见）' },
  { key: 'receipt', label: '收款', hint: '流水与认款核对' },
  { key: 'report', label: '报表', hint: '经营与 no-show 汇总' },
];

// ── 可见性 ────────────────────────────────────────────────────────────
/**
 * staff        —— ADMIN / STAFF（代理禁入：客资或我方成本外流）
 * staffAndAgent—— ADMIN / STAFF / AGENT（代理版由服务端裁列 + 圈到自己和下级代理的订单）
 * finance      —— ADMIN，或 STAFF 且岗位 = FINANCE（与侧栏 financeRole 同口径）
 */
export type ExportAccess = 'staff' | 'staffAndAgent' | 'finance';

/** 参数控件形态；'none' = 无参数，点了就下载。 */
export type ExportParamKind =
  | 'none'
  | 'orderTemplate'
  | 'orderMaster'
  | 'orderIntake'
  | 'schedule'
  | 'roomAllocation'
  | 'dateRange'
  | 'dateRangeOptional'
  | 'seatStats';

export interface ExportEntry {
  id: string;
  group: ExportGroupKey;
  name: string;
  /** 一句话口径：给谁用、按什么口径出。抄自现有按钮文案 / 后端文件头，不自创。 */
  desc: string;
  /** 代理看到的补充说明（仅 access='staffAndAgent' 且当前是代理时展示）。 */
  agentNote?: string;
  access: ExportAccess;
  /** 后端端点，写在卡片角落，方便排查时对得上日志与审计。 */
  endpoint: string;
  param: ExportParamKind;
  /**
   * 需要先勾选订单 / 只对单张订单成立的导出：本页不做，给一个「去哪儿勾」的跳转。
   * 有 jumpTo 的条目不渲染参数与导出按钮。
   */
  jumpTo?: { path: string; label: string };
  /** 原按钮位置（写给运营看：这功能一直都在，在这儿）。 */
  origin: string;
}

/**
 * 18 个导出的登记表。顺序即组内展示顺序。
 * 说明文案来源见文件头纪律。
 */
export const EXPORT_ENTRIES: ExportEntry[] = [
  // ── 录单 ──
  {
    id: 'roster-template',
    group: 'intake',
    name: '名单空白模版',
    desc: '空白 xlsx（姓名 / 护照号 / 出生日期 / 性别）：把收单群里的名单整理成这个格式，再回批量创单上传解析。',
    access: 'staff',
    endpoint: 'GET /orders/roster/template',
    param: 'none',
    origin: '订单管理 · 批量创单弹窗',
  },

  // ── 票务 ──
  {
    id: 'orders-templates',
    group: 'ticketing',
    name: '订单三模板导出',
    desc: '一行一位乘客：《全岗可用》56 列通用台账 /《票务专用》27 列航司 PNR 提交（仅含机票的订单）/《签证专用》21 列越南签证申请表抬头。',
    agentNote:
      '代理版已隐藏内部列（护照身份信息、我方成本与供应商、录入人员、飞行次数、分房等），且只导自己与下级代理的订单。',
    access: 'staffAndAgent',
    endpoint: 'GET /orders/export-templates',
    param: 'orderTemplate',
    origin: '订单管理 · 顶部「导出」',
  },
  {
    id: 'orders-master',
    group: 'ticketing',
    name: '全岗总表',
    desc: '一行一位乘客的完整运营台账，机票 / 酒店 / 签证 / 付款字段全填满；结算价按乘客真实口径，其余金额按出行人均摊。下单时间与出行日期是两个独立区间。',
    agentNote:
      '代理版已隐藏内部列（护照身份信息、我方成本与供应商、录入人员、飞行次数、分房等），且只导自己与下级代理的订单。',
    access: 'staffAndAgent',
    endpoint: 'GET /orders/export/master',
    param: 'orderMaster',
    origin: '订单管理 · 顶部「导出全岗总表」',
  },
  {
    id: 'orders-intake',
    group: 'ticketing',
    name: '进单统计',
    desc: '按「出发日期 × 产品/团期」聚合当期进单：订单数、人数，末行总计。按下单时间窗口统计（可精确到分）。',
    agentNote: '纯聚合表无敏感列；代理只统计自己与下级代理的订单。',
    access: 'staffAndAgent',
    endpoint: 'GET /orders/export/intake',
    param: 'orderIntake',
    origin: '订单管理 · 顶部「进单统计」',
  },
  {
    id: 'orders-by-schedule',
    group: 'ticketing',
    name: '整班机订单明细',
    desc: '按班次拉整班订单，一行一位乘客，用于全班机的乘客 / 房型 / 签证 / 接送清单核对；运营口径，不含成本毛利。',
    access: 'staff',
    endpoint: 'GET /orders/export-by-schedule',
    param: 'schedule',
    origin: '航班管理 · 班次行「导出订单」',
  },
  {
    id: 'seat-stats',
    group: 'ticketing',
    name: '销售控位表',
    desc: '对齐老系统样表：班期 / 航段 / 航班号 / 总机位 / 总确定 / 总预留 / 总余位 / 客座率；Y 舱 = 经济 + 超级经济，C 舱 = 商务 + 头等。',
    access: 'staff',
    endpoint: 'GET /flights/schedules/export-seat-stats',
    param: 'seatStats',
    origin: '航班座位统计页',
  },
  {
    id: 'order-pnr',
    group: 'ticketing',
    name: 'PNR Excel（单张订单）',
    desc: '航司提交格式，一张订单一份。按单出，本页不做。',
    access: 'staff',
    endpoint: 'GET /orders/:id/pnr-export',
    param: 'none',
    jumpTo: { path: '/orders', label: '去订单页打开订单详情' },
    origin: '订单详情 · 运营工具「导出 PNR Excel」',
  },

  // ── 签证 ──
  {
    id: 'visa-roster',
    group: 'visa',
    name: '签证名单表',
    desc: '勾选乘客所属订单合并成一张签证名单 xlsx（同单去重，不含护照图）。要先勾人，本页不做。',
    access: 'staff',
    endpoint: 'POST /orders/visa-roster.xlsx',
    param: 'none',
    jumpTo: { path: '/visa-desk', label: '去签证台勾选后导出' },
    origin: '签证台 · 批量条「下载名单表」',
  },
  {
    id: 'visa-passports',
    group: 'visa',
    name: '签证护照包',
    desc: '勾选订单的护照图打包 zip。签证台入口是送签包口径：自备签乘客的图和表都不含。要先勾人，本页不做。',
    access: 'staff',
    endpoint: 'POST /orders/visa-passports.zip',
    param: 'none',
    jumpTo: { path: '/visa-desk', label: '去签证台勾选后导出' },
    origin: '签证台 · 批量条「下载护照包」',
  },
  {
    id: 'order-passports',
    group: 'visa',
    name: '单张订单护照包',
    desc: '一张订单全员护照图打包 zip（全员资料包口径），含 README 列出缺照片的乘客。按单出，本页不做。',
    access: 'staff',
    endpoint: 'GET /orders/:id/passport-photos.zip',
    param: 'none',
    jumpTo: { path: '/orders', label: '去订单页打开订单详情' },
    origin: '订单详情 · 运营工具「打包护照图片」',
  },

  // ── 房控 ──
  {
    id: 'room-allocation',
    group: 'hotel',
    name: '分房表',
    desc: '成都格式 xlsx：每个入住日期一个 sheet，同 sheet 内按录入时间倒序（拼房关系看「房间号」列）。按入住区间最长 14 天；按出发日则导该日出发订单的整段入住晚。',
    access: 'staff',
    endpoint: 'GET /orders/export-room-allocation',
    param: 'roomAllocation',
    origin: '房控 · 导出分房表',
  },
  {
    id: 'hotel-board',
    group: 'hotel',
    name: '房态销控矩阵',
    desc: '销控矩阵原样导出 xlsx，含「未配包房」标记。',
    access: 'staff',
    endpoint: 'GET /hotel-control/export',
    param: 'dateRange',
    origin: '房控 · 导出房态',
  },

  // ── 财务 ──
  {
    id: 'finance-master',
    group: 'finance',
    name: '财务核对明细（按乘客）',
    desc: '一行一位乘客：收入按订单总额均摊到人；成本 = 机票按包机单座分摊 + 机场税 + 房 / 车 / 签证均摊，带「是否清账」。',
    access: 'finance',
    endpoint: 'GET /finances/export',
    param: 'dateRange',
    origin: '财务 · 全量汇总（按乘客）',
  },
  {
    id: 'finance-by-flight',
    group: 'finance',
    name: '财务对账（按航班）',
    desc: '一行一个班次的整班 P&L：总收入 / 总成本 / 整班毛利 / 单座成本 / 空座成本（空座成本不计入已售座位成本）。',
    access: 'finance',
    endpoint: 'GET /finances/export-by-flight',
    param: 'dateRange',
    origin: '财务 · 按航班分组',
  },
  {
    id: 'finance-by-order',
    group: 'finance',
    name: '财务对账（按订单毛利）',
    desc: '一行一订单，与页面「订单毛利」同一算法；缺任一成本项不当 0 处理，另有「缺成本项数」列标数量。',
    access: 'finance',
    endpoint: 'GET /finances/export-orders',
    param: 'dateRange',
    origin: '财务 · 按订单导出',
  },

  // ── 收款 ──
  {
    id: 'receipt-statement',
    group: 'receipt',
    name: '流水核对表',
    desc: '按收款时间导流水 xlsx，含认款状态 / 认到哪张订单 / 认款人；日期留空 = 全部。',
    access: 'staff',
    endpoint: 'GET /receipts/statement/export',
    param: 'dateRangeOptional',
    origin: '收款对账台 · 导出',
  },

  // ── 报表 ──
  {
    id: 'reports',
    group: 'report',
    name: '经营报表',
    desc: '4 个 sheet：三维度销售毛利（品类 / 渠道 / 代理）+ 应收账龄 + 代理欠款，统一人民币口径。',
    access: 'finance',
    endpoint: 'GET /reports/export',
    param: 'dateRange',
    origin: '经营报表页 · 导出',
  },
  {
    id: 'no-show-report',
    group: 'report',
    name: 'no-show 报表',
    desc: '按班次看 no-show 的后续影响：释放了多少座、又恢复回去多少、还有多少座停在「已释放」；汇总 + 逐单明细两个 sheet。',
    access: 'staff',
    endpoint: 'GET /orders/no-show/report/export',
    param: 'dateRange',
    origin: 'no-show 报表页 · 导出',
  },
];

// ── 角色过滤 ──────────────────────────────────────────────────────────
export interface ExportViewer {
  role: UserRole;
  /** STAFF 的岗位；null / undefined = 通用运营岗。 */
  staffRole?: StaffRole | null;
}

/**
 * 该角色能不能看到这条导出。
 *
 * 与后端 RBAC 的关系：这里只做导航 UX（少给一个入口，不等于放行），真正的闸在后端
 * requireRole / requireFinance / resolveExportAgentScope。宁可前端少给，不可前端多给。
 * CUSTOMER 不进后台，一律 false。
 */
export function canAccessExport(entry: ExportEntry, viewer: ExportViewer): boolean {
  const { role, staffRole } = viewer;
  if (role === 'CUSTOMER') return false;
  switch (entry.access) {
    case 'staffAndAgent':
      return role === 'ADMIN' || role === 'STAFF' || role === 'AGENT';
    case 'staff':
      return role === 'ADMIN' || role === 'STAFF';
    case 'finance':
      // 与侧栏 financeRole 同口径：ADMIN，或 STAFF 且岗位是财务。
      // 登录瞬间 staffRole 还没回来（undefined）时按「不是财务岗」处理 —— 少给入口不伤人，
      // /users/me 回来后这一格自己会出现。
      return role === 'ADMIN' || (role === 'STAFF' && staffRole === 'FINANCE');
    default:
      return false;
  }
}

export function visibleExportEntries(viewer: ExportViewer, entries = EXPORT_ENTRIES): ExportEntry[] {
  return entries.filter((e) => canAccessExport(e, viewer));
}

export interface ExportGroupView extends ExportGroupMeta {
  entries: ExportEntry[];
}

/** 按 EXPORT_GROUPS 顺序分组；空组不返回（代理只剩票务一组时不该看到 6 个空标题）。 */
export function groupExportEntries(
  viewer: ExportViewer,
  entries = EXPORT_ENTRIES,
): ExportGroupView[] {
  const visible = visibleExportEntries(viewer, entries);
  return EXPORT_GROUPS.map((g) => ({
    ...g,
    entries: visible.filter((e) => e.group === g.key),
  })).filter((g) => g.entries.length > 0);
}

// ── 最近导出（localStorage）──────────────────────────────────────────
export const RECENT_EXPORTS_KEY = 'ftm.exportCenter.recent';
export const RECENT_EXPORTS_LIMIT = 20;

export interface RecentExport {
  /** ExportEntry.id */
  id: string;
  /** 导出名称快照（目录改名后老记录仍能读） */
  name: string;
  /** 下载下来的文件名 */
  filename: string;
  /** 参数摘要，如「出行 2026-09-01 ~ 2026-09-30 ·《票务专用》」；无参数导出为空串 */
  summary: string;
  /** ISO 时间戳 */
  at: string;
}

function isRecentExport(v: unknown): v is RecentExport {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.filename === 'string' &&
    typeof r.summary === 'string' &&
    typeof r.at === 'string'
  );
}

/**
 * 解析 localStorage 里的最近导出。
 * 存坏了（手改过 / 旧结构 / 不是 JSON）一律当空数组 —— 这是便利记录，不该因为它让页面崩。
 */
export function parseRecentExports(raw: string | null): RecentExport[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentExport).slice(0, RECENT_EXPORTS_LIMIT);
  } catch {
    return [];
  }
}

/** 追加一条最近导出（不可变：返回新数组），最新在前，超出上限截断。 */
export function appendRecentExport(
  list: readonly RecentExport[],
  entry: RecentExport,
  limit = RECENT_EXPORTS_LIMIT,
): RecentExport[] {
  return [entry, ...list].slice(0, Math.max(0, limit));
}
