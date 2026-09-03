/**
 * 批量 no-show · 匹配结果表。
 * 合格性（eligible / blockers）与「整单还是要拆单」（scope）都由服务端给，本组件只渲染与勾选。
 * 护照一律只显示服务端下发的尾号，不拼全号。
 */
import type { NoShowBatchMatch } from '../../lib/api';
import { MATCHED_BY_LABEL, matchKey } from './noShowMatch';

interface Props {
  matched: NoShowBatchMatch[];
  selectedKeys: Set<string>;
  onToggle: (key: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
}

export function NoShowMatchTable({ matched, selectedKeys, onToggle, onToggleAll }: Props) {
  // 可勾的行 = 服务端判定合格的行（已标过的仍可再勾，只是默认不勾）
  const selectableKeys = matched.filter((m) => m.eligible).map(matchKey);
  const allSelected = selectableKeys.length > 0 && selectableKeys.every((k) => selectedKeys.has(k));

  if (matched.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-sm text-ink-muted">
        名单里没有一行匹配到本班次的乘客。
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="table-admin">
        <thead>
          <tr>
            <th className="w-10">
              <input
                type="checkbox"
                aria-label="全选可标记的乘客"
                checked={allSelected}
                disabled={selectableKeys.length === 0}
                onChange={(e) => onToggleAll(e.target.checked)}
              />
            </th>
            <th className="text-left">姓名</th>
            <th className="text-left">中文名</th>
            <th className="text-left" title="服务端下发的护照尾号；看全号请进订单详情">
              护照尾号
            </th>
            <th className="text-left">订单号</th>
            <th className="text-left">匹配方式</th>
            <th
              className="text-left"
              title="整单 = 本单乘客都在名单里；需拆单 = 只标其中部分人，提交时服务端会先自动拆单"
            >
              范围
            </th>
            <th className="text-left">回程</th>
            <th className="text-left">状态 / 不可标原因</th>
          </tr>
        </thead>
        <tbody>
          {matched.map((m) => {
            const key = matchKey(m);
            return (
              <tr key={key} className={m.eligible ? undefined : 'bg-slate-50 text-ink-muted'}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`标记 ${m.chineseName?.trim() || m.fullName}`}
                    checked={selectedKeys.has(key)}
                    disabled={!m.eligible}
                    onChange={(e) => onToggle(key, e.target.checked)}
                  />
                </td>
                <td className={m.eligible ? 'font-medium text-ink' : 'font-medium'}>{m.fullName}</td>
                <td>{m.chineseName?.trim() || '—'}</td>
                <td className="nums">{m.documentTail?.trim() || '—'}</td>
                <td className="nums">{m.orderNumber}</td>
                <td>
                  {/* 后端加了新匹配方式而前端还没发版时，原样显示比空着强 */}
                  <span className="badge-neutral">
                    {MATCHED_BY_LABEL[m.matchedBy] ?? m.matchedBy}
                  </span>
                  {/* 按姓名匹配可能撞同名，提示核对护照尾号；护照号匹配不提示 */}
                  {m.matchedBy !== 'DOCUMENT' && (
                    <span
                      className="ml-1 text-[11px] text-ink-muted"
                      title="按姓名匹配，提交前请核对护照尾号"
                    >
                      待核对
                    </span>
                  )}
                </td>
                <td>
                  {m.scope === 'SPLIT_REQUIRED' ? (
                    <span
                      className="badge-warning"
                      title="只标本单部分乘客：提交时服务端会先自动拆出新单，再在新单上标记"
                    >
                      需拆单
                    </span>
                  ) : (
                    <span className="badge-neutral">整单</span>
                  )}
                </td>
                <td>
                  {!m.hasReturn ? (
                    <span className="text-ink-muted">单程</span>
                  ) : m.returnDeparted ? (
                    <span className="text-ink-muted" title="回程已起飞，没有可释放的座位">
                      已起飞
                    </span>
                  ) : m.returnTicketed ? (
                    <span className="badge-info" title="回程已出票：释放座位后需要走撤名单 / 退票工单">
                      已出票
                    </span>
                  ) : (
                    <span className="badge-neutral">未出票</span>
                  )}
                </td>
                <td>
                  <div className="flex flex-wrap items-center gap-1">
                    {m.alreadyNoShow && (
                      <span className="badge-neutral" title="此前已标过 no-show">
                        已标记
                      </span>
                    )}
                    {m.blockers.map((b) => (
                      <span key={b} className="badge-danger">
                        {b}
                      </span>
                    ))}
                    {!m.alreadyNoShow && m.blockers.length === 0 && (
                      <span className="text-ink-muted">—</span>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
