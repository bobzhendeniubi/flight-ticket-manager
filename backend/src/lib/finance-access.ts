import { StaffRole, UserRole } from '@prisma/client';

/**
 * 财务岗判定的单一口径：ADMIN 或 STAFF + 财务岗。
 *
 * 两类调用方共用这一个函数，判定只写一处、两边永不漂移：
 *   · plugins/auth.ts 的 requireFinanceAccess —— 整条路由限财务岗的前置闸；
 *   · 服务层里需要「财务岗 or 运营自助」分流的动钱动作（如撤销本人录入且财务未核实的收款）。
 *
 * ADMIN 视同财务：小团队里管理员本就一人多岗，既有口径一直如此。
 * staffRole 由 authenticate / optionalAuthenticate 逐请求从 User 表取回（不进 token），
 * 因此改岗后下一个请求即生效。
 *
 * 放在 lib 而不是 plugins/auth.ts：服务层只要这一个纯判定，不该为它把 fastify 插件
 *（连同 @fastify/jwt、env 校验）拖进模块图。
 */
export function hasFinanceAccess(
  role: UserRole,
  staffRole: StaffRole | null | undefined,
): boolean {
  return role === UserRole.ADMIN || (role === UserRole.STAFF && staffRole === StaffRole.FINANCE);
}
