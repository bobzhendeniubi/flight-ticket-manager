/**
 * 票号批量回填 · 匹配结果表（纯展示 + 勾选，一切判定都来自服务端 preview）。
 *
 * 一行 = 一位乘客。四种状态在同一张表里用底色区分，不拆成四张表 ——
 * 票务要的是「照着名单从上到下核一遍」，拆开反而对不上名单顺序：
 *   · 可回填    白底，默认勾上；
 *   · 覆盖      琥珀底，默认**不**勾 —— 覆盖别人已经录好的号必须是人主动的动作；
 *   · 无变化    灰字，库里已经就是这个号，勾了也没意义（不给勾）；
 *   · 名单矛盾  红底，同一个人在名单里出现了两个不同的号，系统不猜（不给勾）。
 *
 * 「现有 → 新值」那两列永远显示库里此刻的值：没有它，票务没法判断自己是在填空还是在改别人的号。
 */
import type { TicketBatchMatch, TicketMatchedBy } from '../../lib/api';
import { isSubmittable, matchKey } from './ticketBackfill';

const MATCHED_BY_LABEL: Record<TicketMatchedBy, string> = {
  DOCUMENT: '护照号',
  NAME: '英文名',
  CHINESE_NAME: '中文名',
};

/** 一列的变化：库里现值 → 名单里的新值。名单没给这一列就整格显示「不动」。 */
function ValueCell({ current, next }: { current: string | null; next: string | null }) {
  if (next === null) return <span className="text-ink-muted">不动</span>;
  if (current === next) return <span className="font-mono text-ink-muted">{next}（无变化）</span>;
  return (
    <span className="font-mono">
      {current ? <span className="text-ink-muted line-through">{current}</span> : null}
      {current ? ' → ' : null}
      <span className="font-medium text-ink">{next}</span>
    </span>
  );
}

export function TicketMatchTable({
  matched,
  selected,
  onToggle,
  onToggleAll,
}: {
  matched: TicketBatchMatch[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  /** 全选/全不选：只作用在**可提交**的行上（无变化 / 名单矛盾的行永远不进选择集）。 */
  onToggleAll: (checked: boolean) => void;
}) {
  const selectableKeys = matched.filter(isSubmittable).map(matchKey);
  const allSelected = selectableKeys.length > 0 && selectableKeys.every((k) => selected.has(k));

  if (matched.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        名单里没有一行匹配到本班次的乘客。请核对班次是不是选对了，以及名单里的姓名/护照号写法。
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs text-ink-muted">
            <th className="w-10 py-2">
              <input
                type="checkbox"
                aria-label="全选可回填的行"
                checked={allSelected}
                disabled={selectableKeys.length === 0}
                onChange={(e) => onToggleAll(e.target.checked)}
              />
            </th>
            <th className="py-2 pr-3">乘客</th>
            <th className="py-2 pr-3">订单号</th>
            <th className="py-2 pr-3">PNR</th>
            <th className="py-2 pr-3">电子票号</th>
            <th className="py-2 pr-3">名单原文</th>
          </tr>
        </thead>
        <tbody>
          {matched.map((m) => {
            const key = matchKey(m);
            const selectable = isSubmittable(m);
            const rowCls = m.rosterConflict
              ? 'bg-rose-50/70'
              : m.unchanged
                ? 'bg-slate-50/60 text-ink-muted'
                : m.conflict
                  ? 'bg-amber-50/70'
                  : '';
            return (
              <tr key={key} className={`border-b border-slate-100 align-top ${rowCls}`}>
                <td className="py-2">
                  <input
                    type="checkbox"
                    aria-label={`勾选 ${m.fullName}`}
                    checked={selected.has(key)}
                    disabled={!selectable}
                    onChange={() => onToggle(key)}
                  />
                </td>
                <td className="py-2 pr-3">
                  <div className="font-medium text-ink">{m.fullName}</div>
                  <div className="text-xs text-ink-soft">
                    {m.chineseName ? `${m.chineseName} · ` : ''}证件尾号 {m.documentTail || '—'}
                    <span className="ml-1.5 text-ink-muted">
                      （按{MATCHED_BY_LABEL[m.matchedBy]}匹配）
                    </span>
                  </div>
                  {m.rosterConflict && (
                    <div className="mt-1 text-xs font-medium text-rose-700">
                      {m.blockers.join('；')}
                    </div>
                  )}
                  {!m.rosterConflict && m.conflict && (
                    <div className="mt-1 text-xs text-amber-800">
                      库里已有不同的号；要覆盖请先打开下方「允许覆盖已有票号」再勾选。
                    </div>
                  )}
                  {m.unchanged && (
                    <div className="mt-1 text-xs">与系统里现有的号完全一致，无需回填。</div>
                  )}
                </td>
                <td className="py-2 pr-3">
                  <div className="nums font-mono text-xs">{m.orderNumber}</div>
                  <div className="text-xs text-ink-muted">{m.orderStatus}</div>
                </td>
                <td className="py-2 pr-3 text-xs">
                  <ValueCell current={m.currentPnr} next={m.pnr} />
                </td>
                <td className="py-2 pr-3 text-xs">
                  <ValueCell current={m.currentEticketNumber} next={m.eticketNumber} />
                </td>
                <td className="py-2 pr-3 font-mono text-[11px] text-ink-soft">
                  {m.lines.map((l) => (
                    <div key={l}>{l}</div>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
