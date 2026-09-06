/**
 * 前台用到的能力 id —— 后端 backend/src/lib/capabilities.ts 那张表的**子集**。
 *
 * 为什么不像后台那样整表镜像：前台按能力判断的地方只有代理团队与我的佣金两处路由，
 * 抄整张一百来条的表只会多一份会漂的副本。用到新的能力时往这里加一行即可，
 * 写错了会在后端 requireCapability 那儿 403，不会静默放行。
 *
 * 谁持有哪些能力由后端算好，随 GET /users/me 下发（见 stores/auth 的 capabilities 字段）。
 */
export type Capability =
  /** 查看代理列表（代理只看自己与下级）—— 代理团队页。 */
  | 'agents.read'
  /** 查看结算单与代理对账单 —— 我的佣金页。 */
  | 'settlements.read';
