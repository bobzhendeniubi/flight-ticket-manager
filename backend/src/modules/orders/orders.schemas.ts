/**
 * 订单模块的请求体 / 查询参数 schema —— 定义已搬进 @ftm/contracts
 *（packages/contracts/src/orders.ts）。
 *
 * 为什么第一个搬这个：admin-web 的 api.ts 手写了三百多个类型，跟这份 schema 各改各的，
 * 「老标签页撞新后端」「改了后端没改前端」都是从这条缝里漏出来的。订单又是改动最密的
 * 模块（拆单 / 换人 / no-show / 取消航段 / 调价 / 改期 / 票号回填全在这里）。
 *
 * 校验规则一字未改，只换了两处写法：
 *   · `z.nativeEnum(PrismaEnum)` → 契约包里的 `xxxSchema`（同一批值，由枚举漂移测试守住）；
 *   · 几个纯函数 helper 改从 `@ftm/contracts/lib/…` 取（实现是同一份，只是换了家）。
 *
 * 这里留 re-export 壳子，48 个既有调用点（含同目录十几个单测）一个都不用改。
 */
export * from '@ftm/contracts/orders';
