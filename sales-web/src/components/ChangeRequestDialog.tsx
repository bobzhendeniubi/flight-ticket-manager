/**
 * ChangeRequestDialog — 我的订单 · 申请改签弹窗
 *
 * 必填改签原因（2-500 字，占位符引导写清期望的新日期/航班）→ 提交给父组件回调。
 * 提交失败在弹窗内提示：409 ORDER_NOT_CHANGEABLE → 状态不支持改签；其他 → 原样/兜底文案。
 * 成功由父组件负责更新订单状态并关闭本弹窗。
 */
import { useState } from 'react';
import { ApiError, type OrderSummary } from '../lib/api';
import { Icon } from './Icon';
import { Modal } from './Modal';

interface ChangeRequestDialogProps {
  order: OrderSummary;
  onClose: () => void;
  /** 提交改签申请（父组件调 api.requestOrderChange 并更新列表）；抛错则弹窗内展示 */
  onSubmit: (reason: string) => Promise<void>;
}

const REASON_MIN = 2;
const REASON_MAX = 500;

export function ChangeRequestDialog({ order, onClose, onSubmit }: ChangeRequestDialogProps) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN) {
      setError('请填写改签原因（至少 2 个字），并写明期望的新日期或航班');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ORDER_NOT_CHANGEABLE') {
        setError('当前订单状态不支持改签，请联系客服处理');
      } else {
        setError(e instanceof Error ? e.message : '提交失败，请稍后重试');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open onClose={() => !submitting && onClose()} title="申请改签" size="md">
      <div className="space-y-3 p-5 text-sm">
        <div className="text-ink-soft">
          订单 <span className="font-mono font-semibold text-ink">{order.orderNumber}</span>
        </div>

        <div className="rounded-xl border border-sun/40 bg-sun-light px-3 py-2.5 text-xs leading-relaxed text-amber-800">
          改签视航司 / 酒店政策可能产生差价，提交后运营会尽快联系您确认改签方案与费用，确认前不会直接扣款。
        </div>

        <div>
          <label className="label text-xs">改签原因（必填）</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="input w-full"
            placeholder="请写明期望的新日期 / 航班，如：想改到 7 月 20 日同班次，或改乘当天下午的航班"
            maxLength={REASON_MAX}
          />
          <div className="mt-1 text-right text-xs text-ink-muted nums">
            {reason.trim().length}/{REASON_MAX}
          </div>
        </div>

        {error && (
          <div
            className="flex items-center gap-1.5 rounded-xl border border-deal/30 bg-deal-light px-3 py-2 font-medium text-deal-dark"
            role="alert"
          >
            <Icon name="info" className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
      </div>

      <footer className="flex justify-end gap-2 border-t border-slate-200/80 bg-canvas px-5 py-4">
        <button type="button" onClick={onClose} disabled={submitting} className="btn-secondary">
          再想想
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting || reason.trim().length < REASON_MIN}
          className="btn-primary"
        >
          {submitting ? '提交中…' : '提交改签申请'}
        </button>
      </footer>
    </Modal>
  );
}
