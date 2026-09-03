/**
 * 批量 no-show · 匹配结果表。
 * 合格性（eligible / blockers）与「整单还是要拆单」（scope）都由服务端给，本组件只渲染与勾选。
 * 护照一律只显示服务端下发的尾号，不拼全号。
 *
 * 两条只在这张表上成立的口径：
 *   - 「名单原文」列显示命中这位乘客的**全部**原文行（服务端已按人合并）——票务核对的是自己
 *     贴进去的那几个字，不是我们解析出来的名字。
 *   - 服务端说「整单」的单，被取消勾了同单的某个人之后其实只标部分人（执行时会自动拆单），
 *     这一行给琥珀提示，不让它继续写着「整单」蒙人。
 *   - 订单号下面带一行订单备注：本表只针对一个班次，所有行的出发日期天然相同，没有可区分的
 *     「团期」；运营录单时把团组/客人识别信息写在备注里，拿它当可读标识是现成的。
 *   - 回程一列写「票务已确认 / 票务未确认」而不是「已出票 / 未出票」：这里读的是出票任务的
 *     确认状态，与财务的「开票」（订单上的三个开票位）是完全独立的两件事，字面太像会看串。
 */
import type { NoShowBatchMatch } from '../../lib/api';
import { MATCHED_BY_LABEL, matchKey } from './noShowMatch';

interface Props {
  matched: NoShowBatchMatch[];
  selectedKeys: Set<string>;
  /** 本来整单、因取消勾选而变成需拆单的订单 id（见 noShowMatch.downgradedToSplitOrderIds） */
  downgradedOrderIds: Set<string>;
  onToggle: (key: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
}

export function NoShowMatchTable({
  matched,
  selectedKeys,
  downgradedOrderIds,
  onToggle,
  onToggleAll,
}: Props) {
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
            <th className="whitespace-nowrap text-left">姓名</th>
            <th className="whitespace-nowrap text-left">中文名</th>
            <th
              className="whitespace-nowrap text-left"
              title="服务端下发的护照尾号；看全号请进订单详情"
            >
              护照尾号
            </th>
            <th
              className="whitespace-nowrap text-left"
              title="名单里命中这位乘客的原文行（同一人被多行点到时都列出来）"
            >
              名单原文
            </th>
            <th
              className="whitespace-nowrap text-left"
              title="订单号下面是该单的备注原文，用来认人认团。本表只针对一个班次，所有行出发日期天然相同，没有可区分的「团期」"
            >
              订单号 / 备注
            </th>
            <th className="whitespace-nowrap text-left">匹配方式</th>
            <th
              className="whitespace-nowrap text-left"
              title="整单 = 本单乘客都在名单里；需拆单 = 只标其中部分人，提交时服务端会先自动拆单"
            >
              范围
            </th>
            <th className="whitespace-nowrap text-left">回程</th>
            <th className="whitespace-nowrap text-left">状态 / 不可标原因</th>
          </tr>
        </thead>
        <tbody>
          {matched.map((m) => {
            const key = matchKey(m);
            // 服务端没下发 lines 的旧响应：回落到单行 line，别让这一列空着
            const rosterLines = m.lines && m.lines.length > 0 ? m.lines : [m.line];
            const rosterText = rosterLines.join(' / ');
            const downgraded = downgradedOrderIds.has(m.orderId) && selectedKeys.has(key);
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
                <td
                  className={`whitespace-nowrap ${m.eligible ? 'font-medium text-ink' : 'font-medium'}`}
                >
                  {m.fullName}
                </td>
                <td className="whitespace-nowrap">{m.chineseName?.trim() || '—'}</td>
                <td className="nums whitespace-nowrap">{m.documentTail?.trim() || '—'}</td>
                <td>
                  <span
                    className="block max-w-[14rem] truncate font-mono text-xs text-ink-soft"
                    title={rosterText}
                  >
                    {rosterText}
                  </span>
                </td>
                <td className="align-top">
                  <span className="nums block whitespace-nowrap">{m.orderNumber}</span>
                  {/* 备注是运营自己写的识别信息（团组/客人/房型），过长时截断，鼠标悬停看全文 */}
                  {m.notes?.trim() ? (
                    <span
                      className="mt-0.5 block max-w-[12rem] truncate text-[11px] text-ink-soft"
                      title={m.notes}
                    >
                      {m.notes}
                    </span>
                  ) : (
                    <span className="mt-0.5 block text-[11px] text-ink-muted">无备注</span>
                  )}
                </td>
                <td className="whitespace-nowrap">
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
                <td className="whitespace-nowrap">
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
                  {downgraded && (
                    <span
                      className="mt-1 block whitespace-normal text-[11px] leading-4 text-amber-700"
                      title="服务端按整份名单判的是「整单」；取消勾选同单其他人后实际只标部分人，执行时会自动拆单"
                    >
                      取消勾选后该单将变为需拆单，建议重新匹配
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap">
                  {!m.hasReturn ? (
                    <span className="text-ink-muted">单程</span>
                  ) : m.returnDeparted ? (
                    <span className="text-ink-muted" title="回程已起飞，没有可释放的座位">
                      已起飞
                    </span>
                  ) : m.returnTicketed ? (
                    // 「票务已确认」= 该航段的出票任务已确认，与财务的「开票」无关 ——
                    // 单写「已出票」跟「已开票」只差一个字，运营真的看串过。
                    <span
                      className="badge-info"
                      title="回程出票任务已确认（票务口径，与财务「开票」无关）：释放座位后需要走撤名单 / 退票工单"
                    >
                      票务已确认
                    </span>
                  ) : (
                    <span
                      className="badge-neutral"
                      title="回程出票任务尚未确认（票务口径，与财务「开票」无关）"
                    >
                      票务未确认
                    </span>
                  )}
                </td>
                <td>
                  <div className="flex flex-wrap items-center gap-1">
                    {m.alreadyNoShow && (
                      <span className="badge-neutral whitespace-nowrap" title="此前已标过 no-show">
                        已标记
                      </span>
                    )}
                    {m.blockers.map((b) => (
                      <span key={b} className="badge-danger">
                        {b}
                      </span>
                    ))}
                    {m.warning && (
                      <span
                        className="badge-warning"
                        title="多人同名候选就地并入，补预检也没拿到这张单的口径，没有真正过一遍服务端合格性判定"
                      >
                        {m.warning}
                      </span>
                    )}
                    {!m.alreadyNoShow && m.blockers.length === 0 && !m.warning && (
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
