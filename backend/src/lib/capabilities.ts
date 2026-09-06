/**
 * 能力表：前后端共用的**同一张**权限口径。
 *
 * 为什么要这张表：权限判断此前散在 27 个后端文件（约 300 处）和 18 个前端文件（约 180 处），
 * 同一条口径要在两边各写一遍。历史上因此翻过车——只改了后端半边，前端按钮还是灰的，
 * 运营报「没有权限」；反过来只改前端，按钮亮了但一点就 403。
 * 收敛成一张表之后：后端用 requireCapability 判，前端用同一批能力 id 显隐，改口径只改这里一处。
 *
 * ⚠️ 本表只是把**现有规则**原样编码，不是重新设计权限。任何一格与现状不符都是 bug，
 * 不是「顺手改进」。要改口径请单独一次提交、单独说明，并同步更新
 * capabilities.matrix.test.ts 的快照与 docs/权限能力表.md。
 */
import { StaffRole, UserRole } from '@prisma/client';

/** 判定权限所需的全部输入。staffRole 仅对 STAFF 有意义，其余角色恒 null。 */
export interface Principal {
  role: UserRole;
  staffRole?: StaffRole | null;
}

/**
 * 受众：能力的授予范围。
 * 这 8 种形态是从现网受保护端点里归纳出来的全部形态，不多不少。
 */
export type Audience =
  /** 仅管理员。爆炸半径大或定价敏感的操作。 */
  | 'ADMIN_ONLY'
  /** 管理员 + 全部内部员工（不分岗位）。后台绝大多数运营功能。 */
  | 'OPS'
  /** 管理员 + 内部员工 + 代理。代理能自助的功能（服务端另按代理树圈数据）。 */
  | 'OPS_AND_AGENT'
  /** 任何已登录账号（含客户）。守卫层只要求登录，真正的口径在业务里逐单判归属。 */
  | 'ANY_AUTHENTICATED'
  /** 管理员 + 财务岗。对应既有的 requireFinanceAccess。 */
  | 'FINANCE'
  /**
   * 管理员 + 运营岗 + 票务岗（2026-08-25 拍板的「航班维护岗」）。
   * 签证岗 / 房控岗 / 财务岗进不来。
   */
  | 'FLIGHT_MAINTENANCE'
  /** 仅代理。代理自助专用入口。 */
  | 'AGENT_ONLY'
  /** 管理员 + 代理（内部员工反而进不去的少数自助入口）。 */
  | 'ADMIN_AND_AGENT';

/**
 * staffRole 为空 = 运营/通用岗。这是 2026-08-25 起的既有隐含约定；
 * 后来补了显式的 OPERATIONS 枚举值，两者等价——老账号 staffRole 仍是 null，不回填。
 */
export function isGeneralOps(staffRole: StaffRole | null | undefined): boolean {
  return staffRole == null || staffRole === StaffRole.OPERATIONS;
}

/** 受众判定：给定受众与主体，是否授予。 */
function audienceGrants(audience: Audience, p: Principal): boolean {
  const isAdmin = p.role === UserRole.ADMIN;
  const isStaff = p.role === UserRole.STAFF;
  const isAgent = p.role === UserRole.AGENT;
  const isCustomer = p.role === UserRole.CUSTOMER;

  switch (audience) {
    case 'ADMIN_ONLY':
      return isAdmin;
    case 'OPS':
      return isAdmin || isStaff;
    case 'OPS_AND_AGENT':
      return isAdmin || isStaff || isAgent;
    case 'ANY_AUTHENTICATED':
      return isAdmin || isStaff || isAgent || isCustomer;
    case 'FINANCE':
      return isAdmin || (isStaff && p.staffRole === StaffRole.FINANCE);
    case 'FLIGHT_MAINTENANCE':
      return (
        isAdmin || (isStaff && (isGeneralOps(p.staffRole) || p.staffRole === StaffRole.TICKETING))
      );
    case 'AGENT_ONLY':
      return isAgent;
    case 'ADMIN_AND_AGENT':
      return isAdmin || isAgent;
    default: {
      // 穷尽检查：新增受众忘了处理会在编译期报错，而不是静默放行。
      const never: never = audience;
      return never;
    }
  }
}

/**
 * 能力目录：能力 id → { 受众, 说明 }。
 * id 按「域.动作」命名，域与后端模块 / 前端页面对齐，方便双向查找。
 *
 * 「受众」严格照抄现状。有几处看着别扭但确实是现网口径，特别标注、不许顺手改：
 * · payments.verify / payments.unverified 走的是 OPS 而不是 FINANCE——错误文案写着
 *   「仅财务/运营/管理员」，但代码只判 ADMIN||STAFF，任何岗位的员工都能核实到账；
 * · 收款对账台（receipts.*）与成本维护（finances.cost.*）同样是 OPS 而非 FINANCE；
 * · 真正走 requireFinanceAccess 的只有财务页与经营报表两块。
 */
export const CAPABILITIES = {
  // ── 订单 ────────────────────────────────────────────────────────────────
  'orders.read': { audience: 'OPS_AND_AGENT', 说明: '查看订单列表与详情（代理只看自己树内）' },
  'orders.create': { audience: 'OPS_AND_AGENT', 说明: '录单（含批量录单解析、报价试算）' },
  'orders.write': { audience: 'OPS', 说明: '改订单信息：备注、开票标记、航班纠错、状态推进' },
  'orders.split': { audience: 'OPS', 说明: '拆单（含拆单预览）' },
  'orders.cancel': { audience: 'OPS', 说明: '取消整单' },
  'orders.cancel_leg': { audience: 'OPS', 说明: '取消去程/回程航段、作废与恢复回程' },
  'orders.no_show': { audience: 'OPS', 说明: 'no-show 处理（单单与批量）' },
  'orders.reschedule': { audience: 'OPS', 说明: '改期（单单、批量、按人改期）' },
  'orders.price_adjust': { audience: 'OPS', 说明: '调价、应收金额调整与锁定' },
  'orders.passengers.write': { audience: 'OPS', 说明: '改乘客信息、换人、票号、签证日期与自备签' },
  'orders.hotel.write': { audience: 'OPS', 说明: '改订单住宿：换酒店、酒店改期、分房、补房差' },
  'orders.settlement_price.write': { audience: 'OPS', 说明: '改行级结算价' },
  'orders.upgrade_cabin': { audience: 'OPS', 说明: '升舱与加地面项' },
  'orders.change_bundle': { audience: 'OPS', 说明: '套餐改档' },
  'orders.delete': { audience: 'OPS', 说明: '删单与回收站恢复（2026-08-24 放开给内部员工）' },
  'orders.read_deleted': { audience: 'OPS', 说明: '查看回收站' },
  'orders.agent.write': { audience: 'OPS', 说明: '改订单归属代理' },
  'orders.claim': { audience: 'OPS', 说明: '认领订单' },
  'orders.cost_items.manage': { audience: 'OPS', 说明: '订单成本项增删改查' },
  'orders.export.ops': { audience: 'OPS', 说明: '运营侧导出：按班次、分房表、送签名单、护照包' },
  'orders.export.shared': {
    audience: 'OPS_AND_AGENT',
    说明: '代理也能用的导出：三模板、全岗总表、进单统计（服务端强制裁列并圈到自己树内）',
  },
  'orders.batch_lock': { audience: 'OPS', 说明: '批量锁收款 / 锁结算价 / 批量调价' },
  'orders.itinerary': { audience: 'OPS_AND_AGENT', 说明: '行程单 PDF 与 PNR 导出' },

  // ── 收款 / 认款 ──────────────────────────────────────────────────────────
  'payments.read': { audience: 'OPS_AND_AGENT', 说明: '查看收款记录（按归属逐单圈）' },
  'payments.confirm': { audience: 'OPS', 说明: '手工确认收款、批量确认' },
  'payments.verify': { audience: 'OPS', 说明: '到账核实与待核实清单（现状：任何岗位的员工都可以）' },
  'payments.reverse': { audience: 'OPS', 说明: '撤销认款 / 冲销收款' },
  'payments.transfer': { audience: 'OPS', 说明: '款项转移到别的订单' },
  'payments.overpay.handle': { audience: 'OPS', 说明: '超收处理：转预存、挂公池、抵扣代理余额' },
  'payments.sandbox_confirm': { audience: 'ADMIN_ONLY', 说明: '沙箱支付确认（联调用）' },
  'receipts.manage': {
    audience: 'OPS',
    说明: '流水台账：导入、解析、认款、退款、核实挂账、批量匹配、对账表导出',
  },
  'payment_channels.manage': { audience: 'OPS', 说明: '收款渠道（收款码）增删改查' },

  // ── 财务 ────────────────────────────────────────────────────────────────
  'finances.view': { audience: 'FINANCE', 说明: '财务页：毛利、月度、按航班、按订单、三张导出' },
  'finances.cost.manage': {
    audience: 'OPS',
    说明: '成本维护：成本周期、各类成本价、美元汇率、班次成本锁（现状不限财务岗）',
  },
  'reports.view': { audience: 'FINANCE', 说明: '经营报表：销售、应收、代理欠款、四表导出' },
  'refunds.mark_paid': { audience: 'FINANCE', 说明: '退款标记已打款' },
  'settlements.manage': { audience: 'OPS', 说明: '生成结算单、推进结算单状态' },
  'settlements.read': { audience: 'OPS_AND_AGENT', 说明: '查看结算单与代理对账单（代理看自己与下级）' },
  'settlement_rates.write': { audience: 'OPS', 说明: '结算价日历与航段结算价维护' },
  'settlement_discounts.write': { audience: 'OPS', 说明: '代理立减规则维护' },
  'settlement_requests.submit': { audience: 'OPS_AND_AGENT', 说明: '提交议价申请' },
  'settlement_requests.decide': { audience: 'OPS', 说明: '确认 / 驳回议价申请' },
  'agent_recharges.submit': { audience: 'OPS_AND_AGENT', 说明: '提交代理认款充值' },
  'agent_recharges.decide': { audience: 'OPS', 说明: '确认 / 驳回认款、手工调整代理余额' },
  'agent_recharges.my_channels': { audience: 'AGENT_ONLY', 说明: '代理查看自己专属的充值收款码' },
  'agents.commission_rules.manage': { audience: 'OPS', 说明: '代理返佣费率读写' },

  // ── 航班 ────────────────────────────────────────────────────────────────
  'flights.read': { audience: 'OPS_AND_AGENT', 说明: '查看航班与班次（代理侧裁掉成本字段）' },
  'flights.admin_view': {
    // 页面级能力：后台「航班管理」页对全体内部员工开放，代理进不去（改造前是 roles:[ADMIN,STAFF]）。
    // 与 flights.read（接口级，代理也有，用于前台/代理侧选班次）不是一回事，别合并。
    audience: 'OPS',
    说明: '后台航班管理页：查看航班与班次列表',
  },
  'flights.maintain': {
    audience: 'FLIGHT_MAINTENANCE',
    说明: '航班维护：建航班、建班次、改单班次、批量改时刻（运营岗或票务岗）',
  },
  'flights.dangerous': {
    audience: 'ADMIN_ONLY',
    说明: '高危航班操作：整线停售、升舱差价与商务舱联动、批量删班次、批量改容量、删单班次',
  },
  'flights.seat_stats.view': { audience: 'OPS', 说明: '座位统计与导出' },
  'flights.baggage.manage': { audience: 'OPS', 说明: '行李额政策读写' },
  'seat_allocation.manage': { audience: 'OPS', 说明: '切位（包位）分配与回收' },
  'seat_locks.release_any': { audience: 'OPS', 说明: '释放他人的锁位（释放自己的不需要此能力）' },
  'waitlist.read_all': { audience: 'OPS', 说明: '查看整条班次的候补名单' },
  'waitlist.cancel_any': { audience: 'OPS', 说明: '取消他人的候补（取消自己的不需要此能力）' },

  // ── 占位单 / 房控 ────────────────────────────────────────────────────────
  'hold_orders.manage': {
    audience: 'OPS',
    说明: '占位单全流程：建单、转正、释放、取消、分期认款、改价改人改归属',
  },
  'hold_orders.config.write': { audience: 'ADMIN_ONLY', 说明: '占位单全局配置' },
  'hotel_control.view': { audience: 'OPS', 说明: '房控看板、前瞻、缺口清单、预警、导出、护照包' },
  'hotel_control.manage': { audience: 'OPS', 说明: '包房周期增删改、超售上限' },

  // ── 产品 ────────────────────────────────────────────────────────────────
  'products.write': { audience: 'OPS', 说明: '酒店 / 接送 / 签证 / 套餐增删改' },
  'products.cost.view': { audience: 'OPS', 说明: '看产品成本价（代理与游客看不到）' },
  'cancellation_policies.manage': { audience: 'OPS', 说明: '取消政策维护' },

  // ── 履约 / 签证台 / 提醒 ─────────────────────────────────────────────────
  'fulfillment.manage': {
    audience: 'OPS',
    说明: '工单看板、签证任务状态、重发行程单、签证成本回填',
  },
  'reminders.manage': { audience: 'OPS', 说明: '提醒中心：生成、认领、释放、处理' },

  // ── 客户 / 代理 / 旅客 ───────────────────────────────────────────────────
  'agents.read': { audience: 'OPS_AND_AGENT', 说明: '查看代理列表（代理只看自己与下级）' },
  'agents.self.read': { audience: 'ADMIN_AND_AGENT', 说明: '读自己的代理档案（内部员工反而没有）' },
  'agents.create_child': { audience: 'OPS_AND_AGENT', 说明: '新建下级代理' },
  'agents.write': { audience: 'OPS_AND_AGENT', 说明: '改代理联系信息（代理只能改自己那条）' },
  'agents.status.write': { audience: 'ADMIN_ONLY', 说明: '停用 / 启用代理登录' },
  'agents.settlement_mode.write': { audience: 'ADMIN_ONLY', 说明: '改代理结算模式（单结 / 月结）' },
  'customers.manage': { audience: 'OPS_AND_AGENT', 说明: '散客读写（代理圈到自己树内）' },
  'travelers.manage': { audience: 'OPS_AND_AGENT', 说明: '旅客读写（代理圈到自己树内）' },
  'traveler_profiles.manage': {
    audience: 'OPS',
    说明: '旅客档案：查询、合并、权益核销、重建（内部资产，不对代理开放）',
  },

  // ── 申请单 ──────────────────────────────────────────────────────────────
  'change_requests.submit': { audience: 'OPS_AND_AGENT', 说明: '提交改单申请（含批量）' },
  'change_requests.decide': { audience: 'OPS', 说明: '确认 / 驳回改单申请（含批量与待办计数）' },
  'change_requests.view_cost': { audience: 'OPS', 说明: '看申请单里的成本差额（代理侧要裁掉）' },
  'bundle_change_requests.submit': { audience: 'OPS_AND_AGENT', 说明: '提交套餐改档申请' },
  'bundle_change_requests.decide': { audience: 'OPS', 说明: '确认 / 驳回套餐改档申请' },

  // ── 账号 / 系统 ──────────────────────────────────────────────────────────
  'users.reset_agent_password': {
    audience: 'OPS',
    说明: '重置代理账号密码（2026-08-26：内部员工都可以）',
  },
  'users.reset_staff_password': {
    audience: 'ADMIN_ONLY',
    说明: '重置内部账号密码（仅管理员，防员工借重置接管同事账号）',
  },
  'users.staff.manage': { audience: 'ADMIN_ONLY', 说明: '开内部账号、设岗位、停用启用' },
  'users.create_account': { audience: 'OPS', 说明: '经注册口建账号' },
  'feature_flags.read': { audience: 'OPS', 说明: '查看功能开关状态' },
  'feature_flags.write': { audience: 'ADMIN_ONLY', 说明: '改功能开关' },
  'settings.ai_ocr.manage': { audience: 'ADMIN_ONLY', 说明: 'AI 识别设置（供应商、密钥、模型、连通性测试）' },
  'audit.read': { audience: 'OPS', 说明: '审计日志' },
  'dashboard.view': { audience: 'OPS', 说明: '仪表盘与预警汇总' },
  'marketing.manage': { audience: 'OPS', 说明: '营销中心：海报模板与生成' },
  'legacy.read': { audience: 'OPS', 说明: '老系统历史档案（只读区）' },
  'ocr.passport': { audience: 'OPS_AND_AGENT', 说明: '护照识别（代理录单也要用）' },
} as const satisfies Record<string, { audience: Audience; 说明: string }>;

/** 全部能力 id 的联合类型。前后端共用同一批字面量。 */
export type Capability = keyof typeof CAPABILITIES;

/** 全部能力 id（稳定排序，供文档生成与测试枚举用）。 */
export const ALL_CAPABILITIES: Capability[] = (Object.keys(CAPABILITIES) as Capability[]).sort();

/**
 * 纯函数：算出一个主体持有的全部能力。
 * 无副作用、不查库——后端每次请求现算，前端直接用 /users/me 返回的这份。
 */
export function capabilitiesFor(principal: Principal): Capability[] {
  return ALL_CAPABILITIES.filter((cap) => audienceGrants(CAPABILITIES[cap].audience, principal));
}

/** 单点判定，免得调用方为了问一个能力去构造整个数组。 */
export function hasCapability(principal: Principal, cap: Capability): boolean {
  return audienceGrants(CAPABILITIES[cap].audience, principal);
}
