/**
 * 套餐不可售日期（blackout）编辑器 —— 后台「新建/编辑套餐」用。
 *
 * 按出发日维度，单套餐粒度设置某些日期不可售（如春节封盘）。
 * 对外约定：
 *   - `value`: `{ date: string; reason?: string }[]`（date = YYYY-MM-DD）
 *   - `onChange(next)`: emit 新数组（不可变更新）
 *   - 添加时按日期去重；reason 仅作展示提示，限 60 字
 *   - 受 backend 契约限制：最多 120 条
 */

export interface BlackoutDateRow {
  date: string; // YYYY-MM-DD
  reason?: string;
}

const MAX_BLACKOUT_DATES = 120;
const MAX_REASON_LEN = 60;

/** 本地日期（YYYY-MM-DD），用于 <input min> 限制不能选过去日 */
function todayYmd(): string {
  const d = new Date();
  const tzOffsetMs = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 10);
}

export function BundleBlackoutEditor({
  value,
  onChange,
}: {
  value: BlackoutDateRow[];
  onChange: (next: BlackoutDateRow[]) => void;
}) {
  const today = todayYmd();
  const atLimit = value.length >= MAX_BLACKOUT_DATES;

  const addRow = () => {
    if (atLimit) return;
    onChange([...value, { date: '', reason: '' }]);
  };

  const removeRow = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  const updateDate = (idx: number, date: string) => {
    // 去重：若该日期已存在于其它行，则忽略本次修改（保持原值）
    if (date && value.some((r, i) => i !== idx && r.date === date)) return;
    onChange(value.map((r, i) => (i === idx ? { ...r, date } : r)));
  };

  const updateReason = (idx: number, reason: string) => {
    onChange(value.map((r, i) => (i === idx ? { ...r, reason } : r)));
  };

  return (
    <div>
      <label className="label !mb-1">不可售日期（封盘）</label>
      <p className="mb-2 text-xs text-ink-muted">
        按出发日设置该套餐不可售的日期（如春节封盘）。仅影响本套餐，最多 {MAX_BLACKOUT_DATES} 条。
      </p>

      {value.length > 0 && (
        <div className="space-y-2">
          {value.map((row, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                type="date"
                min={today}
                className="input !w-auto"
                value={row.date}
                onChange={(e) => updateDate(idx, e.target.value)}
              />
              <input
                type="text"
                className="input flex-1"
                placeholder='原因（如"春节封盘"，可选）'
                maxLength={MAX_REASON_LEN}
                value={row.reason ?? ''}
                onChange={(e) => updateReason(idx, e.target.value)}
              />
              <button
                type="button"
                className="btn-ghost px-2 py-1 text-rose-600"
                onClick={() => removeRow(idx)}
                aria-label="删除该封盘日期"
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        className="btn-secondary mt-2 text-xs"
        onClick={addRow}
        disabled={atLimit}
      >
        + 添加封盘日期
      </button>
      {atLimit && (
        <p className="mt-1 text-xs text-amber-600">已达上限 {MAX_BLACKOUT_DATES} 条</p>
      )}
    </div>
  );
}
