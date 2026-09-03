/**
 * 订单操作记录（审计轨迹）— 详情抽屉里的折叠区。
 *
 * 操作岗需要在订单上看到「什么时间、哪个账号、改了什么」。
 * 默认收起，展开后才拉数据（targetType=ORDER + targetId=该订单，倒序取最近 PAGE_SIZE 条）。
 * 动作代码 → 中文名走本文件的 ORDER_ACTION_LABELS（未登记的动作显示原始代码）；
 * 关键变化摘要复用 lib/auditFormat.summarizePayload（自动挑金额/状态类字段，不整段 dump）。
 * 完整 before/after 明细请到审计日志页查看。
 *
 * 权限：仅 ADMIN/STAFF 渲染（审计查询 API 也只放行这两个角色）。
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AuditLog } from '../lib/api';
import { useAuth } from '../stores/auth';
import { summarizePayload } from '../lib/auditFormat';
import { businessTzParts } from '../lib/datetime';

/**
 * 订单模块实际写入 targetType=ORDER 的 action 全集 → 中文名。
 * 覆盖 orders/fulfillment/finances/receipts/settlements/cancellation 各处对订单的埋点。
 * 新增订单侧埋点时在此补一行；未登记的 action 会兜底显示原始代码。
 */
const ORDER_ACTION_LABELS: Record<string, string> = {
  // ── 下单 / 状态流转 ──
  CREATE_ORDER: '创建订单',
  BATCH_CREATE_ORDERS: '批量创建订单',
  CLAIM_ORDER: '认领订单',
  CHANGE_ORDER_AGENT: '更改归属代理',
  ADVANCE_ORDER_STATUS: '推进订单状态',
  FORCE_ORDER_STATUS: '强制改订单状态',
  BATCH_ADVANCE_ORDER_STATUS: '批量推进订单状态',
  BATCH_FORCE_ORDER_STATUS: '批量强制改状态',
  SOFT_DELETE_ORDER: '删除订单',
  RESTORE_ORDER: '恢复订单',
  REQUEST_CANCELLATION: '申请取消订单',
  REQUEST_CHANGE: '申请改签',
  RESCHEDULE_ORDER_ITEM: '改期航班',
  RESCHEDULE_PASSENGERS: '按人改期',
  SPLIT_ORDER: '拆单',
  SPLIT_ORDER_COMMISSION: '拆单·佣金分配',
  MARK_NO_SHOW: '标记去程 no-show',
  RESTORE_RETURN_LEG: '恢复回程',
  RESTORE_RETURN_LEG_OVERSOLD: '恢复回程（超售放行）',
  RESTORE_RETURN_LEG_DISPLACED_RESERVATION: '恢复回程（挤占预留座）',
  VOID_RETURN_LEG: '作废回程',
  CANCEL_RETURN_LEG: '取消回程',
  CANCEL_OUTBOUND_LEG: '取消去程',
  // ── 乘客 / 酒店 / 分房 ──
  SWAP_ORDER_PASSENGER: '换人',
  SWAP_ORDER_ITEM_HOTEL: '更换酒店',
  RESCHEDULE_ORDER_ITEM_HOTEL: '酒店改期',
  UPDATE_ROOM_ASSIGNMENT: '调整分房',
  ADD_ROOM_SUPPLEMENT: '补收单房差',
  FORCE_DUPLICATE_PASSENGERS: '强制放行重复乘客',
  PARSE_ROSTER: '解析乘客名单',
  // ── 定价 / 成本 ──
  ADJUST_ORDER_PRICE: '订单调价',
  ADD_ORDER_PRICE_ADJUSTMENT: '按乘客调价',
  UPDATE_ITEM_SETTLEMENT_PRICE: '修改结算价',
  UPDATE_ORDER_COST_ITEM: '更新订单成本项',
  APPLY_SETTLEMENT_TOTAL: '应用结算总额',
  AGENT_SELF_SETTLEMENT: '代理自助改结算价',
  // ── 收款 / 支付 / 财务 ──
  CREATE_PAYMENT: '创建支付',
  CONFIRM_MANUAL_PAYMENT: '确认收款',
  BATCH_CONFIRM_MANUAL_PAYMENT: '批量确认收款',
  PAYMENT_SUCCEEDED: '支付成功',
  PAYMENT_CALLBACK_REJECTED: '支付回调被拒',
  MINIAPP_PREPAY: '小程序预支付',
  CUSTOMER_UPLOAD_RECEIPT: '客户上传凭证',
  ALLOCATE_RECEIPT: '流水认款',
  REVERSE_RECEIPT_ALLOCATION: '撤销认款',
  APPLY_AGENT_BALANCE: '代理余额抵扣',
  CREDIT_OVERPAY_TO_AGENT: '多付转代理余额',
  ORDER_OVERPAY_TO_POOL: '多付转公共池',
  SET_EXPECTED_AMOUNT: '设置预期到账金额',
  LOCK_EXPECTED_AMOUNT: '锁定预期到账金额',
  UNLOCK_EXPECTED_AMOUNT: '解锁预期到账金额',
  // ── 开票 ──
  UPDATE_INVOICE_STATUS: '更新开票状态',
  // ── 备注 ──
  UPDATE_ORDER_NOTES: '更新订单备注',
  // ── 履约 ──
  UPDATE_FULFILLMENT_TASK: '更新履约任务',
  REISSUE_FULFILLMENT_TASK: '重新执行履约任务',
  BATCH_UPDATE_FULFILLMENT_STATUS: '批量更新履约状态',
  BATCH_UPDATE_FULFILLMENT_NOTES: '批量更新履约备注',
  RESEND_ITINERARY: '重发行程单',
  // ── 导出 / 下载 ──
  DOWNLOAD_ITINERARY: '下载行程单',
  DOWNLOAD_PASSPORTS: '下载护照',
  DOWNLOAD_VISA_PASSPORTS: '下载签证护照',
  DOWNLOAD_ROSTER_TEMPLATE: '下载名单模板',
  DOWNLOAD_VISA_ROSTER: '下载签证名单',
  EXPORT_ORDER_INTAKE: '导出订单录入表',
  EXPORT_ORDER_MASTER: '导出订单主表',
  EXPORT_ORDER_TEMPLATES: '导出订单模板',
  EXPORT_PNR: '导出 PNR',
  EXPORT_ROOM_ALLOCATION: '导出分房表',
};

/** 动作代码 → 中文名；未登记的动作显示原始代码，避免误导。 */
function actionLabel(code: string): string {
  return ORDER_ACTION_LABELS[code] ?? code;
}

/** 审计时刻，固定北京时间（原先用 getHours 等取浏览器时区，境外看会跟导出对不上）。 */
function fmtTime(iso: string): string {
  const parts = businessTzParts(iso);
  if (!parts) return iso;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const PAGE_SIZE = 50;

interface OrderAuditTrailProps {
  orderId: string;
}

export function OrderAuditTrail({ orderId }: OrderAuditTrailProps) {
  const token = useAuth((s) => s.tokens)?.accessToken ?? '';
  const role = useAuth((s) => s.user?.role);
  const isOps = role === 'ADMIN' || role === 'STAFF';

  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<AuditLog[]>([]);

  // 展开才拉数据；已加载或加载中不重复请求。
  const load = () => {
    if (loaded || loading || !token) return;
    setLoading(true);
    setError(null);
    api
      .listAuditLogs(token, { targetType: 'ORDER', targetId: orderId, pageSize: PAGE_SIZE })
      .then((r) => {
        setLogs(r.logs);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : '加载操作记录失败');
      })
      .finally(() => setLoading(false));
  };

  // AGENT 等非运营角色不展示（审计查询 API 仅放行 ADMIN/STAFF）。
  if (!isOps) return null;

  return (
    <details
      className="rounded-xl border border-slate-200 bg-white"
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open) load();
      }}
    >
      <summary className="cursor-pointer select-none px-4 py-3 text-xs font-semibold uppercase tracking-wide text-ink-muted hover:text-ink">
        操作记录
      </summary>
      <div className="border-t border-slate-100 px-4 py-3">
        {loading && <div className="text-xs text-ink-muted">加载中…</div>}
        {error && (
          <div className="text-xs text-rose-600">
            {error}
            <button
              type="button"
              className="ml-2 font-medium text-brand hover:text-brand-dark"
              onClick={load}
            >
              重试
            </button>
          </div>
        )}
        {loaded && !error && logs.length === 0 && (
          <div className="text-xs text-ink-muted">暂无操作记录。</div>
        )}
        {logs.length > 0 && (
          <ol className="space-y-2.5">
            {logs.map((l) => {
              const summary = summarizePayload(l.action, l.before, l.after);
              return (
                <li key={l.id} className="border-l-2 border-slate-200 pl-3 text-xs">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="nums text-[11px] text-ink-muted">{fmtTime(l.createdAt)}</span>
                    <span className="font-medium text-ink">{actionLabel(l.action)}</span>
                    <span className="text-ink-soft">· {l.actorLabel ?? '系统'}</span>
                  </div>
                  {summary && summary !== '—' && (
                    <div className="mt-0.5 text-ink-soft">{summary}</div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {loaded && logs.length >= PAGE_SIZE && (
          <div className="mt-2 text-[11px] text-ink-muted">仅显示最近 {PAGE_SIZE} 条。</div>
        )}
        {/* 完整 before/after 明细在审计日志页（仅 ADMIN 可进该页）。 */}
        {role === 'ADMIN' && (
          <div className="mt-3 border-t border-slate-100 pt-2">
            <Link
              to="/audit-logs"
              className="text-[11px] font-medium text-brand hover:text-brand-dark"
            >
              在审计日志页查看完整明细 →
            </Link>
          </div>
        )}
      </div>
    </details>
  );
}
