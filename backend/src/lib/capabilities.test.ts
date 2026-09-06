/**
 * 内联闸对照表：证明「能力检查」与被它替换掉的「角色判断」逐格等价。
 *
 * capabilities.matrix.test.ts 盯的是 preHandler 那一层。但订单、收款这些最要紧的口径
 * 根本不在 preHandler 上——它们是写在 handler / service 里的内联 403。那一层没法靠路由
 * introspection 抓，于是在这里逐条抄下**替换前**的判断式，断言它与新能力对每个主体
 * 给出完全一样的结论。
 *
 * 用法：把内联判断改成 requireCapability / hasCapability 之前，先在下表登记一行；
 * 改完之后这张表就是回归网——能力表编码错了，这里立刻红。
 * legacy 那一列必须是**替换前源码的逐字转写**，不许「顺手修正」，否则这测试就白写了。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { StaffRole, UserRole } from '@prisma/client';
import {
  ALL_CAPABILITIES,
  CAPABILITIES,
  capabilitiesFor,
  hasCapability,
  isGeneralOps,
  type Capability,
  type Principal,
} from './capabilities.js';

/** 全部主体：角色 × 岗位。OPERATIONS 与留空必须处处同权。 */
const PRINCIPALS: Array<{ label: string; principal: Principal }> = [
  { label: 'ADMIN', principal: { role: UserRole.ADMIN, staffRole: null } },
  { label: 'STAFF/运营(留空)', principal: { role: UserRole.STAFF, staffRole: null } },
  {
    label: 'STAFF/运营(显式)',
    principal: { role: UserRole.STAFF, staffRole: StaffRole.OPERATIONS },
  },
  { label: 'STAFF/签证岗', principal: { role: UserRole.STAFF, staffRole: StaffRole.VISA_DESK } },
  { label: 'STAFF/票务岗', principal: { role: UserRole.STAFF, staffRole: StaffRole.TICKETING } },
  { label: 'STAFF/房控岗', principal: { role: UserRole.STAFF, staffRole: StaffRole.ROOM_CONTROL } },
  { label: 'STAFF/财务岗', principal: { role: UserRole.STAFF, staffRole: StaffRole.FINANCE } },
  { label: 'AGENT', principal: { role: UserRole.AGENT, staffRole: null } },
  { label: 'CUSTOMER', principal: { role: UserRole.CUSTOMER, staffRole: null } },
];

/**
 * 替换前的原始判断式，逐字转写自各模块源码。
 * role / staffRole 就是当时代码里读到的 req.user.role / req.staffRole（或 actor.role）。
 */
type LegacyPredicate = (role: UserRole, staffRole: StaffRole | null) => boolean;

const isOps: LegacyPredicate = (role) => role === UserRole.ADMIN || role === UserRole.STAFF;
const isOpsOrAgent: LegacyPredicate = (role) =>
  role === UserRole.ADMIN || role === UserRole.STAFF || role === UserRole.AGENT;
const isAdmin: LegacyPredicate = (role) => role === UserRole.ADMIN;
/** requireFinanceAccess 的逐字转写。 */
const isFinance: LegacyPredicate = (role, staffRole) =>
  role === UserRole.ADMIN || (role === UserRole.STAFF && staffRole === StaffRole.FINANCE);

interface InlineGate {
  /** 内联判断所在位置，改完之后仍应指得准。 */
  来源: string;
  cap: Capability;
  legacy: LegacyPredicate;
}

const INLINE_GATES: InlineGate[] = [
  // ── 收款：payments.routes.ts 一串 `role !== ADMIN && role !== STAFF → 403` ──────
  {
    来源: 'payments.routes.ts POST /payments/manual-confirm（仅运营/管理员可确认收款）',
    cap: 'payments.confirm',
    legacy: isOps,
  },
  {
    来源: 'payments.routes.ts POST /payments/batch-confirm（仅运营/管理员可确认收款）',
    cap: 'payments.confirm',
    legacy: isOps,
  },
  {
    来源: 'payments.routes.ts POST /payments/:paymentId/reverse（仅运营/管理员可撤销收款）',
    cap: 'payments.reverse',
    legacy: isOps,
  },
  {
    来源: 'payments.routes.ts POST /payments/:paymentId/transfer（仅运营/管理员可转移收款）',
    cap: 'payments.transfer',
    legacy: isOps,
  },
  {
    // 文案写着「仅财务/运营/管理员」，但代码只判 ADMIN||STAFF —— 照抄现状，不借重构改口径。
    来源: 'payments.routes.ts POST /payments/:paymentId/verify（文案提财务，实判 ADMIN||STAFF）',
    cap: 'payments.verify',
    legacy: isOps,
  },
  {
    来源: 'payments.routes.ts GET /payments/unverified（同上，实判 ADMIN||STAFF）',
    cap: 'payments.verify',
    legacy: isOps,
  },

  // ── 认款 / 议价 / 改单 / 改档：一律「仅运营/管理员」 ────────────────────────────
  {
    来源: 'agent-recharges.service.ts confirm()（仅运营/管理员可确认认款）',
    cap: 'agent_recharges.decide',
    legacy: isOps,
  },
  {
    来源: 'agent-recharges.service.ts reject()（仅运营/管理员可驳回认款）',
    cap: 'agent_recharges.decide',
    legacy: isOps,
  },
  {
    来源: 'agent-recharges.service.ts manualAdjust()（仅运营/管理员可手动调整代理余额）',
    cap: 'agent_recharges.decide',
    legacy: isOps,
  },
  {
    来源: 'agent-recharges.service.ts myChannels()（仅代理可查询专属收款渠道）',
    cap: 'agent_recharges.my_channels',
    legacy: (role) => role === UserRole.AGENT,
  },
  {
    来源: 'settlement-requests.service.ts approve()（仅运营/管理员可确认议价申请）',
    cap: 'settlement_requests.decide',
    legacy: isOps,
  },
  {
    来源: 'settlement-requests.service.ts reject()（仅运营/管理员可驳回议价申请）',
    cap: 'settlement_requests.decide',
    legacy: isOps,
  },
  {
    来源: 'settlement-requests.service.ts create() 的兜底否决（无权限提交议价申请）',
    cap: 'settlement_requests.submit',
    legacy: isOpsOrAgent,
  },
  {
    来源: 'bundle-change-requests.service.ts approve()（仅运营/管理员可确认改档申请）',
    cap: 'bundle_change_requests.decide',
    legacy: isOps,
  },
  {
    来源: 'bundle-change-requests.service.ts reject()（仅运营/管理员可驳回改档申请）',
    cap: 'bundle_change_requests.decide',
    legacy: isOps,
  },
  {
    来源: 'bundle-change-requests.service.ts create() 的兜底否决（无权限提交改档申请）',
    cap: 'bundle_change_requests.submit',
    legacy: isOpsOrAgent,
  },
  {
    来源: 'order-change-requests.service.ts assertOps()（仅运营/管理员可审批改单申请）',
    cap: 'change_requests.decide',
    legacy: isOps,
  },
  {
    来源: 'order-change-requests.service.ts resolveSubmitterAgentId() 的兜底否决',
    cap: 'change_requests.submit',
    legacy: isOpsOrAgent,
  },
  {
    来源: 'order-change-requests.service.ts canSeeCost()（代理侧裁掉成本差额）',
    cap: 'change_requests.view_cost',
    legacy: isOps,
  },

  // ── 代理：两处 ADMIN 专属 + 三处兜底否决 ──────────────────────────────────────
  {
    来源: 'agents.service.ts setSettlementMode()（仅管理员可设置代理结算模式）',
    cap: 'agents.settlement_mode.write',
    legacy: isAdmin,
  },
  {
    来源: 'agents.service.ts setActive()（仅管理员可停用/启用代理）',
    cap: 'agents.status.write',
    legacy: isAdmin,
  },
  {
    来源: 'agents.service.ts listVisibleAgents() 的兜底否决（无权限查看代理列表）',
    cap: 'agents.read',
    legacy: isOpsOrAgent,
  },
  {
    来源: 'agents.service.ts createChildAgent() 的兜底否决（无权限创建代理）',
    cap: 'agents.create_child',
    legacy: isOpsOrAgent,
  },
  {
    来源: 'agents.service.ts updateAgent() 的兜底否决（无权限修改代理信息）',
    cap: 'agents.write',
    legacy: isOpsOrAgent,
  },
  {
    来源: 'agent-statements.service.ts resolveStatementScope()（客户一律不许看代理对账单）',
    cap: 'settlements.read',
    legacy: isOpsOrAgent,
  },

  // ── 锁位 / 候补：本人之外要 ops ──────────────────────────────────────────────
  {
    来源: 'seat-locks.service.ts releaseLock() 的 isOps（非本人只有运营/管理员能释放）',
    cap: 'seat_locks.release_any',
    legacy: isOps,
  },
  {
    来源: 'waitlist.service.ts cancelEntry() 的 isOps（非本人只有运营/管理员能取消）',
    cap: 'waitlist.cancel_any',
    legacy: isOps,
  },

  // ── 账号：2026-08-26 拍板的两级重置口径 ──────────────────────────────────────
  {
    // 原判断：`req.user.role !== ADMIN && target.role !== AGENT` → 403。
    // 拆成两个能力后：重置代理密码 = 内部员工都行；重置内部账号密码 = 仅管理员。
    来源: 'users.routes.ts POST /users/:id/reset-password —— 目标是代理时',
    cap: 'users.reset_agent_password',
    legacy: isOps,
  },
  {
    来源: 'users.routes.ts POST /users/:id/reset-password —— 目标是内部账号时',
    cap: 'users.reset_staff_password',
    legacy: isAdmin,
  },

  // ── 航班维护岗（2026-08-25）──────────────────────────────────────────────────
  {
    // 原判断：ADMIN || (STAFF && (staffRole == null || staffRole === TICKETING))
    来源: 'flights.routes.ts requireFlightMaintenance（需要运营或票务岗权限）',
    cap: 'flights.maintain',
    legacy: (role, staffRole) =>
      role === UserRole.ADMIN ||
      (role === UserRole.STAFF && (staffRole == null || staffRole === StaffRole.TICKETING)),
  },

  // ── 产品成本可见性 ──────────────────────────────────────────────────────────
  {
    来源: 'products.routes.ts isCostVisible()（代理与游客看不到成本价）',
    cap: 'products.cost.view',
    legacy: isOps,
  },

  // ── 订单：内联 403 的大头，一个能力登记一行（同判断式的多个端点合并在 来源 里）──
  // orders.routes.ts / orders.service.ts 里绝大多数是同一个模板：
  //   `role !== ADMIN && role !== STAFF → ForbiddenError('仅运营/管理员可…')`
  {
    来源: 'orders 批量建单里的定价三闸（议价结算价 / 手动结算单价 / 优惠，仅运营）',
    cap: 'orders.price_adjust',
    legacy: isOps,
  },
  {
    来源: 'orders.routes.ts POST /orders/batch（客户不可批量建单，其余登录身份都放行）',
    cap: 'orders.create',
    legacy: isOpsOrAgent,
  },
  {
    来源: 'orders.routes.ts POST /:id/claim（仅运营/管理员可认领订单）',
    cap: 'orders.claim',
    legacy: isOps,
  },
  {
    来源: 'orders.routes.ts PATCH /:id/notes 的 isOps（内部备注四栏与签证状态仅运营可改）',
    cap: 'orders.write',
    legacy: isOps,
  },
  {
    来源: 'orders.routes.ts PATCH /:id/expected-amount 的锁后旁路（已锁定，请联系管理员）',
    cap: 'orders.expected_amount.override_lock',
    legacy: isAdmin,
  },
  {
    来源: 'orders.service.ts _updateStatusWithinTx 的 isAdminForce（强制流转只认管理员）',
    cap: 'orders.force_status',
    legacy: isAdmin,
  },
  {
    来源: 'orders.routes.ts POST /:id/correct-flight（仅运营 / 代理可纠正航班）',
    cap: 'orders.correct_flight',
    legacy: isOpsOrAgent,
  },
  {
    来源: 'orders.service.ts swapPassenger / swapPreview（仅运营/代理可换人、看换人预览）',
    cap: 'orders.passengers.swap',
    legacy: isOpsOrAgent,
  },
  {
    来源: 'orders.routes.ts GET /swap-fee-options（仅运营/代理可查看换人费档位）',
    cap: 'orders.swap_fee_options.read',
    legacy: isOpsOrAgent,
  },
  {
    来源: 'orders.routes.ts PUT /swap-fee-options（仅管理员可修改换人费档位）',
    cap: 'orders.swap_fee_options.write',
    legacy: isAdmin,
  },
  {
    来源: 'orders.routes.ts POST /:id/items/:itemId/upgrade-cabin（运营 + 代理当日自助）',
    cap: 'orders.upgrade_cabin',
    legacy: isOpsOrAgent,
  },
  {
    来源: 'orders.routes.ts PATCH /:id/items/:itemId/hotel（运营 + 代理当日自助换酒店）',
    cap: 'orders.hotel.swap',
    legacy: isOpsOrAgent,
  },
  {
    来源: 'orders.service.ts rescheduleItemHotel / splitHotelItemByRoomGroup / addRoomSupplement 与 PUT /:id/room-assignment',
    cap: 'orders.hotel.write',
    legacy: isOps,
  },
  {
    来源: 'orders.service.ts addGroundItem（仅运营/管理员可补录地面项）',
    cap: 'orders.add_ground_item',
    legacy: isOps,
  },
  {
    来源: 'orders.service.ts softDeleteOrder / listDeletedOrders / restoreOrder（仅内部员工可删除订单）',
    cap: 'orders.delete',
    legacy: isOps,
  },
  {
    来源: 'orders.service.ts creditOverpayToAgent / applyAgentBalanceToOrder / overpayToPool',
    cap: 'payments.overpay.handle',
    legacy: isOps,
  },
  {
    来源: 'orders.service.ts updateItemSettlementPrice（仅运营/管理员可改结算价）',
    cap: 'orders.settlement_price.write',
    legacy: isOps,
  },
  {
    来源: 'orders.service.ts updatePassengerVisaDates / updatePassengerTicket / setPassengerVisaExempt',
    cap: 'orders.passengers.write',
    legacy: isOps,
  },
  {
    来源: 'orders.service.ts rescheduleOrderItem / reschedulePassengers 与批量改期',
    cap: 'orders.reschedule',
    legacy: isOps,
  },
  {
    来源: 'orders.service.ts previewOrderSplit / splitOrder（仅运营/管理员可拆单）',
    cap: 'orders.split',
    legacy: isOps,
  },
  {
    来源: 'orders.service.ts previewCancelLeg / cancelLeg / restoreReturnLeg / voidReturnLeg',
    cap: 'orders.cancel_leg',
    legacy: isOps,
  },
  {
    来源: 'orders.service.ts previewNoShow / markNoShow 与批量 no-show',
    cap: 'orders.no_show',
    legacy: isOps,
  },
  {
    来源: 'orders.service.ts changeOrderAgent（仅运营/管理员可改归属代理）',
    cap: 'orders.agent.write',
    legacy: isOps,
  },
  {
    来源: 'orders.service.ts changeOrderBundle（仅运营/管理员可套餐改档）',
    cap: 'orders.change_bundle',
    legacy: isOps,
  },
  {
    来源: 'orders.service.ts batchAddPriceAdjustment / addPriceAdjustment 的 isOps',
    cap: 'orders.price_adjust',
    legacy: isOps,
  },
  {
    来源: 'orders.routes.ts POST /tickets/batch 与 /tickets/batch-preview（票号批量回填）',
    cap: 'orders.passengers.write',
    legacy: isOps,
  },
  {
    来源: 'orders.routes.ts POST /:id/payments-lock 与 /batch/payments-lock（收款复核锁）',
    cap: 'orders.payments_lock',
    legacy: isOps,
  },

  // ── 第二波新增模块（2026-09-06）────────────────────────────────────────────
  {
    来源: 'suppliers.routes.ts / supplier-invoices.routes.ts 的 requireFinance（原 requireFinanceAccess）',
    cap: 'finances.supplier_payables.manage',
    legacy: isFinance,
  },
  {
    来源: 'invoices.routes.ts POST /:id/issue 与 /:id/void 的 requireFinance（原 requireFinanceAccess）',
    cap: 'invoices.issue',
    legacy: isFinance,
  },
  {
    // 原判断：`role === ADMIN → 放行；role === STAFF && staffRole === VISA_DESK → 放行；其余 403`
    来源: 'order-change-requests.service.ts assertVisaDeskForVisaExempt（确认改自备签只放行管理员与签证岗）',
    cap: 'change_requests.approve_visa_exempt',
    legacy: (role, staffRole) =>
      role === UserRole.ADMIN ||
      (role === UserRole.STAFF && staffRole === StaffRole.VISA_DESK),
  },
];

describe('能力表：与替换前的内联角色判断逐格等价', () => {
  for (const gate of INLINE_GATES) {
    it(`${gate.cap} ← ${gate.来源}`, () => {
      for (const { label, principal } of PRINCIPALS) {
        // 显式运营岗是新加的枚举值，老判断式里没有它；按既有约定它等价于留空。
        const legacyStaffRole =
          principal.staffRole === StaffRole.OPERATIONS ? null : (principal.staffRole ?? null);
        const expected = gate.legacy(principal.role, legacyStaffRole);
        expect(
          hasCapability(principal, gate.cap),
          `${label} 对 ${gate.cap} 的结论与替换前不一致`,
        ).toBe(expected);
      }
    });
  }
});

describe('能力表自身的不变量', () => {
  it('显式运营岗与留空处处同权（OPERATIONS ≡ null）', () => {
    const 留空 = capabilitiesFor({ role: UserRole.STAFF, staffRole: null });
    const 显式 = capabilitiesFor({ role: UserRole.STAFF, staffRole: StaffRole.OPERATIONS });
    expect(显式).toEqual(留空);
  });

  it('isGeneralOps 只认「留空」与「显式运营岗」', () => {
    expect(isGeneralOps(null)).toBe(true);
    expect(isGeneralOps(undefined)).toBe(true);
    expect(isGeneralOps(StaffRole.OPERATIONS)).toBe(true);
    for (const s of [
      StaffRole.VISA_DESK,
      StaffRole.TICKETING,
      StaffRole.ROOM_CONTROL,
      StaffRole.FINANCE,
    ]) {
      expect(isGeneralOps(s)).toBe(false);
    }
  });

  it('管理员拥有除「代理专属」外的全部能力', () => {
    const admin = capabilitiesFor({ role: UserRole.ADMIN, staffRole: null });
    const agentOnly = ALL_CAPABILITIES.filter((c) => CAPABILITIES[c].audience === 'AGENT_ONLY');
    expect([...admin].sort()).toEqual(
      ALL_CAPABILITIES.filter((c) => !agentOnly.includes(c)).sort(),
    );
  });

  it('客户拿不到任何后台能力', () => {
    expect(capabilitiesFor({ role: UserRole.CUSTOMER, staffRole: null })).toEqual([]);
  });

  /**
   * 前端镜像一致性：admin-web/src/lib/capabilities.ts 手抄了同一批 id，两边必须一字不差。
   *
   * 这不是洁癖。漂了会静默坏事，而且是两个方向各坏一种：
   * · 前端多一个后端没有的 id —— 谁都拿不到它，挂着它的菜单/页面对**所有人**消失
   *   （2026-09-06 就这么把「航班管理」整页藏了：前端写 flights.admin_view，后端表里根本没有）；
   * · 前端少一个 —— 该显示的按钮永远不显示，运营报「没有权限」，后端其实是放行的。
   * 前端不引后端代码（构建边界），所以只能靠这条测试钉住。
   */
  it('前端能力清单镜像与后端逐字一致', () => {
    const mirrorPath = fileURLToPath(
      new URL('../../../admin-web/src/lib/capabilities.ts', import.meta.url),
    );
    const mirror = readFileSync(mirrorPath, 'utf8');
    const mirrored = [...mirror.matchAll(/^\s*\|\s*'([a-z_.]+)'/gm)].map((m) => m[1]).sort();
    expect(mirrored).toEqual([...ALL_CAPABILITIES].sort());
  });

  it('每个能力都有说明，id 用「域.动作」形式', () => {
    for (const cap of ALL_CAPABILITIES) {
      expect(CAPABILITIES[cap].说明.length, `${cap} 缺说明`).toBeGreaterThan(0);
      expect(cap, `${cap} 不是「域.动作」形式`).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
    }
  });
});
