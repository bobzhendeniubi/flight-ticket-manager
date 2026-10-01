/**
 * 议价申请差额行的身份标 —— 订单服务（套餐改档分类）与议价申请服务两头共用。
 *
 * 放在 orders/ 下而不是 settlement-requests/ 下：orders.service 不能反向 import 议价申请服务（后者依赖前者），
 * 可改档分类又必须认得这类行。文案常量也挪到这里，settlement-requests.service 原样再导出，调用方不变。
 *
 * 口径：议价申请（运营确认 / 代理自助直通）落的差额行 = 「把应收收敛到谈定价」。谈定价是针对**旧档**谈的，
 * 结算价 = 本单最终收多少；改档后以新档日历价为准，这条行归**套餐块**（被日历价整体替换，不当额外行保留）。
 *   · 新行：metadata.settlementRequest = true + settlementRequestId（可回溯到申请）；
 *   · 存量行：没有这个标，但 reasonText 由服务端写死成两句固定文案（人工调价下拉填不出来），凭它可靠识别。
 */

/** 运营确认议价申请生成的差额行说明（固定文案，让订单详情那一行自己说清楚它是怎么来的）。 */
export const SETTLEMENT_REQUEST_REASON_TEXT = '代理议价申请（运营确认）';

/**
 * 代理自助直通生成的差额行说明。与上面那条分开，是为了在订单详情/导出里一眼分得清
 * 「运营确认过的议价」和「代理自己改的价」——两者钱一样动，追责路径不一样。
 */
export const AGENT_SELF_SETTLEMENT_REASON_TEXT = '代理自助改结算价';

/** 新落的议价差额行要带的身份标（随 buildPriceAdjustmentItem 的 metadata 一起写进行）。 */
export function settlementRequestAdjustmentMetadata(requestId: string): Record<string, unknown> {
  return { settlementRequest: true, settlementRequestId: requestId };
}

/**
 * 这一行是不是议价申请落的差额行（新行认身份标，存量行认固定 reasonText）。
 * 入参是行 metadata 读成的对象（readJsonObject 之后），不是整行。
 */
export function isSettlementRequestAdjustment(meta: Record<string, unknown>): boolean {
  if (meta.settlementRequest === true) return true;
  const reasonText = meta.reasonText;
  return (
    reasonText === SETTLEMENT_REQUEST_REASON_TEXT || reasonText === AGENT_SELF_SETTLEMENT_REASON_TEXT
  );
}
