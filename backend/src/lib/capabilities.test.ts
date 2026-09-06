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
