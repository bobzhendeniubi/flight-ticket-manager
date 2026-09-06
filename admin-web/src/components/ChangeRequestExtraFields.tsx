/**
 * 改单申请 · 扩展三类（拆单 / 取消单程 / 改自备签）的选择器与预检卡片。
 *
 * 从 ChangeRequestModal 里拆出来单独一份：那四类基础申请选的是「哪一行 + 换成什么」，
 * 这三类选的是「哪几个人」「哪一段」，表单形状完全不同，混在一个文件里两边都难读。
 *
 * 这三项只在后端 flag AGENT_CHANGE_REQUEST_EXTRA_KINDS 开着时才会出现 ——
 * 由父组件按 GET /order-change-requests/kinds 的返回决定，本组件不自己判开关。
 *
 * 文案一律用合作方视角：说「我们送签 / 我们确认执行」，不说内部岗位名。
 */
import type {
  OrderChangeRequestPreview,
  OrderItem,
  OrderPassenger,
  OrderSummary,
} from '../lib/api';

/** 出行人展示名：中文名优先，没有就用护照拼音名。 */
export function passengerLabel(p: OrderPassenger): string {
  return p.chineseName || p.fullName;
}

function fmtCny(amount: number): string {
  return `¥${Math.round(amount).toLocaleString()}`;
}

/** 本单已占座的机票行（取消单程要至少有两段，才谈得上「取消其中一段」）。 */
export function bookedFlightItems(order: OrderSummary): OrderItem[] {
  return (order.items ?? []).filter((it) => it.kind === 'FLIGHT' && Boolean(it.flightScheduleId));
}

// ── 预检卡片 ────────────────────────────────────────────────────────────────

export interface ChangeRequestPreviewCardProps {
  loading: boolean;
  preview: OrderChangeRequestPreview | null;
  /** 预检请求本身失败（网络/鉴权）时的文案；与 blockers 是两回事，别混着展示。 */
  error: string | null;
}

/**
 * 预检结果：不满足的条件逐条摆出来（原样用服务端那句人话，前端不自己拼），
 * 取消单程再补一行预估退款。
 */
export function ChangeRequestPreviewCard({
  loading,
  preview,
  error,
}: ChangeRequestPreviewCardProps) {
  if (loading) return <div className="text-xs text-slate-500">正在核对是否可以提交…</div>;
  if (error) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        没能提前核对（{error}）。仍可提交，我们会在收到申请时再核对一次。
      </div>
    );
  }
  if (!preview) return null;

  return (
    <div className="space-y-2">
      {preview.cancelLeg && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-700">
          <div className="font-medium text-slate-900">
            取消{preview.cancelLeg.legLabel}
            {preview.cancelLeg.flightNumber ? ` ${preview.cancelLeg.flightNumber}` : ''}
            {preview.cancelLeg.departDate ? ` ${preview.cancelLeg.departDate}` : ''}
          </div>
          <div className="mt-1">
            预估退款 <span className="nums font-medium">{fmtCny(preview.cancelLeg.refundCny)}</span>
            {preview.cancelLeg.policyName ? `（${preview.cancelLeg.policyName}）` : ''}
          </div>
          <div className="mt-1 text-slate-500">
            按取消政策计算，最终金额以确认执行时为准。另一段照常出行。
          </div>
        </div>
      )}

      {preview.split && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-700">
          随拆分走的份额{' '}
          <span className="nums font-medium">{fmtCny(preview.split.movedShareCny)}</span>
          <div className="mt-1 text-slate-500">
            两边金额合计不变，座位与房间也照旧，只是分成两张单各自往下走。
          </div>
        </div>
      )}

      {preview.warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
          {preview.warnings.map((w) => (
            <li key={w}>· {w}</li>
          ))}
        </ul>
      )}

      {!preview.eligible && (
        <ul className="space-y-1 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-700">
          {preview.blockers.map((b) => (
            <li key={b}>· {b}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── 拆单：勾要拆出去的人 ─────────────────────────────────────────────────────

export interface SplitPassengerPickerProps {
  passengers: OrderPassenger[];
  selectedIds: string[];
  onToggle: (passengerId: string) => void;
  preview: OrderChangeRequestPreview | null;
  disabled?: boolean;
}

export function SplitPassengerPicker({
  passengers,
  selectedIds,
  onToggle,
  preview,
  disabled,
}: SplitPassengerPickerProps) {
  const selected = new Set(selectedIds);
  return (
    <div className="space-y-2">
      <span className="label">要拆出来的出行人</span>
      <p className="text-xs leading-relaxed text-slate-500">
        勾上要单独成一张单的人，至少留 1 位在原订单。金额按每人份额分开，两边合计不变。
      </p>
      <ul className="space-y-1">
        {passengers.map((p) => {
          const share = preview?.split?.shares.find((s) => s.passengerId === p.id);
          return (
            <li key={p.id}>
              <label className="flex cursor-pointer items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selected.has(p.id)}
                    disabled={disabled}
                    onChange={() => onToggle(p.id)}
                  />
                  <span>{passengerLabel(p)}</span>
                </span>
                {share && <span className="nums text-slate-500">{fmtCny(share.shareCny)}</span>}
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── 取消单程：选去程 / 回程 ──────────────────────────────────────────────────

export interface CancelLegPickerProps {
  value: 'OUTBOUND' | 'RETURN';
  onChange: (leg: 'OUTBOUND' | 'RETURN') => void;
  disabled?: boolean;
}

export function CancelLegPicker({ value, onChange, disabled }: CancelLegPickerProps) {
  return (
    <label className="block">
      <span className="label">取消哪一段</span>
      <select
        className="input mt-1 w-full"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === 'OUTBOUND' ? 'OUTBOUND' : 'RETURN')}
      >
        <option value="RETURN">回程（只飞去程）</option>
        <option value="OUTBOUND">去程（只飞回程）</option>
      </select>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">
        被取消那一段的座位会放回去重新销售，退款按取消政策计算。
      </p>
    </label>
  );
}

// ── 改自备签：选人 + 改成自备 / 随团办签 ─────────────────────────────────────

export interface VisaExemptPickerProps {
  passengers: OrderPassenger[];
  passengerId: string;
  onPassengerChange: (passengerId: string) => void;
  visaExempt: boolean;
  onVisaExemptChange: (visaExempt: boolean) => void;
  disabled?: boolean;
}

export function VisaExemptPicker({
  passengers,
  passengerId,
  onPassengerChange,
  visaExempt,
  onVisaExemptChange,
  disabled,
}: VisaExemptPickerProps) {
  const current = passengers.find((p) => p.id === passengerId);
  return (
    <>
      <label className="block">
        <span className="label">改哪一位</span>
        <select
          className="input mt-1 w-full"
          value={passengerId}
          disabled={disabled}
          onChange={(e) => onPassengerChange(e.target.value)}
        >
          {passengers.map((p) => (
            <option key={p.id} value={p.id}>
              {passengerLabel(p)}
              {p.visaExempt ? '（当前：自备签）' : '（当前：随团办签）'}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="label">改成</span>
        <select
          className="input mt-1 w-full"
          value={visaExempt ? 'SELF' : 'GROUP'}
          disabled={disabled}
          onChange={(e) => onVisaExemptChange(e.target.value === 'SELF')}
        >
          <option value="SELF">自备签（客人自己已有签证，无需送签）</option>
          <option value="GROUP">随团办签（由我们送签）</option>
        </select>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          {current?.visaExempt === visaExempt
            ? '这位出行人当前就是这个状态，换一个目标再提交。'
            : '套餐单的价格会按下单时的减免标准同步调整；送签进度会重置为待处理。'}
        </p>
      </label>
    </>
  );
}
