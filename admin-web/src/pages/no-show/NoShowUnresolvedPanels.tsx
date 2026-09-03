/**
 * 批量 no-show · 两个「没收干净」的提示块：
 *   1. 未匹配 —— 名单里查无此人（错字 / 不是本班次 / 单已取消）
 *   2. 多人同名 —— 一行命中多位乘客，必须人工挑一个再重新匹配
 *
 * 同名候选只带订单号与姓名（服务端口径），没有可提交的订单内部 id，所以这里**不直接提交**：
 * 运营选定后把该行换成更精确的写法（选定者的证件姓名）重新匹配。宁可多跑一趟，
 * 也不能猜错人去标 no-show。
 */
import type { NoShowAmbiguousLine } from '../../lib/api';

interface Props {
  unmatched: string[];
  ambiguous: NoShowAmbiguousLine[];
  /** line → 选中的 passengerId */
  choices: Record<string, string>;
  onChoose: (line: string, passengerId: string) => void;
  /** 把该行替换成选定乘客的证件姓名（回到名单框，等运营再点一次「匹配」） */
  onApplyChoice: (line: string, replacement: string) => void;
}

export function NoShowUnresolvedPanels({
  unmatched,
  ambiguous,
  choices,
  onChoose,
  onApplyChoice,
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
            一行命中了多位乘客，系统不替你挑人。选定后点「替换该行」，名单里会换成该乘客的证件姓名，
            再点一次「匹配」即可；仍然分不开时改用护照号。
          </p>
          <ul className="mt-2 space-y-2">
            {ambiguous.map((amb) => {
              const chosenId = choices[amb.line];
              const chosen = amb.candidates.find((c) => c.passengerId === chosenId) ?? null;
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
                          onChange={() => onChoose(amb.line, c.passengerId)}
                        />
                        <span className="font-medium text-ink">{c.fullName}</span>
                        {c.chineseName?.trim() && (
                          <span className="text-ink-soft">{c.chineseName}</span>
                        )}
                        <span className="nums text-xs text-ink-muted">{c.orderNumber}</span>
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn-secondary mt-1.5 py-1 text-xs"
                    disabled={!chosen}
                    onClick={() => chosen && onApplyChoice(amb.line, chosen.fullName)}
                  >
                    替换该行
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
