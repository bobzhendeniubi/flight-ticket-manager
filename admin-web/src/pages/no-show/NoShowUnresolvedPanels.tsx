/**
 * 批量 no-show · 两个「没收干净」的提示块：
 *   1. 未匹配 —— 名单里查无此人（错字 / 不是本班次 / 单已取消）
 *   2. 多人同名 —— 一行命中多位乘客，选一个就地并入下方「匹配结果」表
 *
 * 同名候选现在带订单内部 id（orderId），选定后不用运营再把名单文字换掉、手工点一次
 * 「匹配」——直接并入 matched 列表；页面会在背后自动拿新文本重新预检一遍核对口径。
 */
import type { NoShowAmbiguousCandidate, NoShowAmbiguousLine } from '../../lib/api';

interface Props {
  unmatched: string[];
  ambiguous: NoShowAmbiguousLine[];
  /** line → 选中的 passengerId（仅用于本轮渲染态；重新预检后这一行多半会从 ambiguous 里消失） */
  choices: Record<string, string>;
  /** 选中某个候选：由父组件负责替换名单文字、钉住选择并触发重新预检 */
  onChoose: (line: string, candidate: NoShowAmbiguousCandidate) => void;
  /** 页面正在重新预检时，禁用选择避免重复触发 */
  disabled?: boolean;
}

export function NoShowUnresolvedPanels({
  unmatched,
  ambiguous,
  choices,
  onChoose,
  disabled,
}: Props) {
  if (unmatched.length === 0 && ambiguous.length === 0) return null;

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {unmatched.length > 0 && (
        <section className="card border-amber-200 bg-amber-50/60">
          <h2 className="text-sm font-semibold text-amber-800">未匹配 · {unmatched.length} 行</h2>
          <p className="mt-0.5 text-xs text-amber-700">
            这些行在本班次里没找到对应乘客：可能是拼写与护照不一致、不是这个班次、或者单已取消。
            核对后改名单再匹配一次；不处理也不影响下方已匹配的提交。
          </p>
          <ul className="mt-2 space-y-1 text-sm text-ink">
            {unmatched.map((line) => (
              <li key={line} className="rounded bg-white/70 px-2 py-1 font-mono text-xs">
                {line}
              </li>
            ))}
          </ul>
        </section>
      )}

      {ambiguous.length > 0 && (
        <section className="card border-rose-200 bg-rose-50/60">
          <h2 className="text-sm font-semibold text-rose-800">多人同名 · {ambiguous.length} 行</h2>
          <p className="mt-0.5 text-xs text-rose-700">
            一行命中了多位乘客，系统不替你挑人。点选其中一位，会直接并入下方「匹配结果」表
            （背后会自动核对一遍口径）；仍然分不开时改用护照号。
          </p>
          <ul className="mt-2 space-y-2">
            {ambiguous.map((amb) => {
              const chosenId = choices[amb.line];
              return (
                <li key={amb.line} className="rounded-lg bg-white/80 p-2">
                  <div className="font-mono text-xs text-ink-muted">{amb.line}</div>
                  <div className="mt-1 space-y-1">
                    {amb.candidates.map((c) => (
                      <label
                        key={c.passengerId}
                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-slate-50"
                      >
                        <input
                          type="radio"
                          name={`ambiguous-${amb.line}`}
                          checked={chosenId === c.passengerId}
                          disabled={disabled}
                          onChange={() => onChoose(amb.line, c)}
                        />
                        <span className="font-medium text-ink">{c.fullName}</span>
                        {c.chineseName?.trim() && (
                          <span className="text-ink-soft">{c.chineseName}</span>
                        )}
                        <span className="nums text-xs text-ink-muted">{c.orderNumber}</span>
                      </label>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
