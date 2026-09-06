/**
 * 批量申请改单（代理专属，订单列表勾选多单后的批量工具条入口）。
 * 只支持两种批量改动：VISA（三档签证状态）与 FLIGHT（去/回程 + 新班次），与
 * OrdersPage 里运营专属的「批量改航班」用同一套航班/班次二级下拉（这里另起一份小 hook，
 * 因为那份是 OrdersPage 的模块私有实现，组件文件拿不到）。提交只落一批 PENDING 申请，
 * 订单本身不会立即改变；运营在「改单申请」队列里逐条或批量确认执行。
 */
import { useState } from 'react';
import {
  ApiError,
  orderChangeRequestsApi,
  type ChangeRequestVisaStatus,
  type OrderChangeRequestBatchResultItem,
} from '../lib/api';
import { useAuth } from '../stores/auth';
import { Modal } from './Modal';
import {
  CHANGE_REQUEST_VISA_STATUS_OPTIONS,
  scheduleLabel,
  useChangeRequestFlightSchedules,
} from './orderChangeRequestShared';

export interface BatchOrderChangeRequestModalProps {
  orderIds: string[];
  onClose: () => void;
  /** 提交完成（无论是否全部成功）后回调，调用方据此刷新列表/徽标。 */
  onDone: () => void;
}

type BatchKind = 'VISA' | 'FLIGHT';

/**
 * 单次批量申请的订单条数上限 —— 对齐后端 batchOrderChangeRequestBodySchema 的 .max(200)。
 * 列表里勾选的硬上限是 500，超过 200 直接发出去会被 Zod 整体打回、一条都不会创建；
 * 与其余批量端点一样在前端先拦下并提示分批。
 */
const BATCH_CHANGE_REQUEST_ORDER_LIMIT = 200;

export function BatchOrderChangeRequestModal({ orderIds, onClose, onDone }: BatchOrderChangeRequestModalProps) {
  const token = useAuth((s) => s.tokens)?.accessToken ?? '';

  const [kind, setKind] = useState<BatchKind>('VISA');
  const [toVisaStatus, setToVisaStatus] = useState<ChangeRequestVisaStatus>('NEEDED');
  const [leg, setLeg] = useState<'OUTBOUND' | 'RETURN'>('OUTBOUND');
  const [flightId, setFlightId] = useState('');
  const [newScheduleId, setNewScheduleId] = useState('');
  const { flights, schedules, loadingSchedules, error: flightOptionsError } = useChangeRequestFlightSchedules(
    token,
    flightId,
    kind === 'FLIGHT',
  );
  const [note, setNote] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; skipped: number; results: OrderChangeRequestBatchResultItem[] } | null>(null);

  const overLimit = orderIds.length > BATCH_CHANGE_REQUEST_ORDER_LIMIT;
  const canSubmit = !overLimit && (kind === 'VISA' ? true : Boolean(newScheduleId));

  const submit = async (): Promise<void> => {
    if (!token || !canSubmit || submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      const body =
        kind === 'VISA'
          ? { orderIds, kind: 'VISA' as const, payload: { toVisaStatus }, note: note.trim() || undefined }
          : { orderIds, kind: 'FLIGHT' as const, payload: { leg, newScheduleId }, note: note.trim() || undefined };
      const res = await orderChangeRequestsApi.batchCreateOrderChangeRequests(token, body);
      setResult({ created: res.created, skipped: res.skipped, results: res.results });
      onDone();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? e.message : '提交失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`批量申请改单 · 已选 ${orderIds.length} 条`}
      size="md"
      footer={
        result ? (
          <div className="flex justify-end">
            <button type="button" className="btn-primary" onClick={onClose}>关闭</button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" disabled={submitting} onClick={onClose}>取消</button>
            <button
              type="button"
              className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
              disabled={submitting || !canSubmit}
              onClick={() => void submit()}
            >
              {submitting ? '提交中…' : `提交到 ${orderIds.length} 条`}
            </button>
          </div>
        )
      }
    >
      <div className="space-y-4 px-5 py-4 text-sm">
        {result ? (
          <div className="space-y-2">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
              已提交 {result.created} 条，跳过 {result.skipped} 条（多为该订单已有待处理的同类改单申请）。
            </div>
            {result.results.length > 0 && (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-ink-muted">
                    <tr>
                      <th className="px-2 py-1.5">订单号</th>
                      <th className="px-2 py-1.5">结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.results.map((row) => (
                      <tr key={row.orderId} className="border-t border-slate-100">
                        <td className="px-2 py-1.5 font-mono">{row.orderNumber ?? row.orderId}</td>
                        <td className={`px-2 py-1.5 ${row.ok ? 'text-emerald-700' : 'text-rose-600'}`}>
                          {row.ok ? '已提交' : (row.reason ?? '跳过')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : (
          <>
            {overLimit && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-900">
                单次最多批量申请 {BATCH_CHANGE_REQUEST_ORDER_LIMIT} 条订单，请分批操作（当前已选 {orderIds.length} 条）。
              </div>
            )}
            <div className="rounded-lg bg-brand-50 px-3 py-2.5 text-xs leading-relaxed text-brand-700">
              提交后不会立即改动这些订单，运营在「改单申请」队列里确认执行才会真正生效；已有待处理同类申请的订单会被跳过。
            </div>

            <label className="block">
              <span className="label">申请类型</span>
              <select
                className="input mt-1 w-full"
                value={kind}
                onChange={(e) => setKind(e.target.value as BatchKind)}
                disabled={submitting}
              >
                <option value="VISA">签证状态</option>
                <option value="FLIGHT">改航班</option>
              </select>
            </label>

            {kind === 'VISA' && (
              <label className="block">
                <span className="label">目标签证状态</span>
                <select
                  className="input mt-1 w-full"
                  value={toVisaStatus}
                  onChange={(e) => setToVisaStatus(e.target.value as ChangeRequestVisaStatus)}
                  disabled={submitting}
                >
                  {CHANGE_REQUEST_VISA_STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
            )}

            {kind === 'FLIGHT' && (
              <>
                <div className="flex gap-4">
                  <label className="flex items-center gap-1.5 text-sm text-ink-soft">
                    <input
                      type="radio"
                      name="batch-ocr-leg"
                      checked={leg === 'OUTBOUND'}
                      onChange={() => setLeg('OUTBOUND')}
                      disabled={submitting}
                    />
                    改去程
                  </label>
                  <label className="flex items-center gap-1.5 text-sm text-ink-soft">
                    <input
                      type="radio"
                      name="batch-ocr-leg"
                      checked={leg === 'RETURN'}
                      onChange={() => setLeg('RETURN')}
                      disabled={submitting}
                    />
                    改回程
                  </label>
                </div>
                <label className="block">
                  <span className="label">选航班</span>
                  <select
                    className="input mt-1 w-full"
                    value={flightId}
                    onChange={(e) => { setFlightId(e.target.value); setNewScheduleId(''); }}
                    disabled={submitting}
                  >
                    <option value="">选择航班…</option>
                    {flights.map((f) => (
                      <option key={f.id} value={f.id}>{f.flightNumber} · {f.originCode}→{f.destinationCode}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="label">新班次{loadingSchedules && '（加载中…）'}</span>
                  <select
                    className="input mt-1 w-full disabled:bg-slate-100"
                    value={newScheduleId}
                    onChange={(e) => setNewScheduleId(e.target.value)}
                    disabled={!flightId || loadingSchedules || submitting}
                  >
                    <option value="">选择班次…</option>
                    {schedules.map((s) => (
                      <option key={s.id} value={s.id}>{scheduleLabel(s)}</option>
                    ))}
                  </select>
                </label>
                {flightOptionsError && <div className="text-xs text-rose-600">{flightOptionsError}</div>}
              </>
            )}

            <label className="block">
              <span className="label">备注（选填）</span>
              <input
                className="input mt-1 w-full"
                value={note}
                maxLength={200}
                onChange={(e) => setNote(e.target.value)}
                placeholder="给运营的补充说明"
                disabled={submitting}
              />
            </label>

            {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
          </>
        )}
      </div>
    </Modal>
  );
}
