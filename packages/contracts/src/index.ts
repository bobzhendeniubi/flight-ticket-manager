/**
 * @ftm/contracts —— 前后端契约的唯一事实源
 *
 * 这里放三类东西：
 *   1. Prisma 枚举镜像（enums.ts）；
 *   2. 请求体 / 查询参数的 zod schema（按后端模块分文件）；
 *   3. 响应 DTO 的类型（纯 TS type，**不在后端响应路径上做 parse**，只做类型约束）。
 *
 * 后端 `*.schemas.ts` 已改成 `export * from '@ftm/contracts/<module>'`，所有既有 import
 * 路径保持可用；前端 `api.ts` 用 `import type { … } from '@ftm/contracts'` 取同一份类型，
 * 不再手抄。加新端点的流程见 docs/前后端契约.md。
 *
 * 桶文件只 re-export，不定义任何东西。同名符号在两个模块里都存在时，按下面的顺序后来
 * 者覆盖前者会被 TS 直接报错 —— 真撞名了就改从子路径导入（`@ftm/contracts/orders`）。
 */

// 枚举镜像、错误码、公共信封与纯函数 helper
export * from './common.js';
export * from './enums.js';
export * from './errors.js';
export * from './lib/business-time.js';
export * from './lib/country-codes.js';
export * from './lib/flight-time.js';
export * from './lib/passenger-name.js';
export * from './lib/proof-url.js';
export * from './lib/ticket-number.js';

// 各模块的请求体 / 查询参数 schema 与响应 DTO
export * from './agent-recharges.js';
export * from './agents.js';
export * from './audit.js';
export * from './auth.js';
export * from './bundle-change-requests.js';
export * from './customers.js';
export * from './flight-settlement-rates.js';
export * from './flights.js';
export * from './fulfillment.js';
export * from './hold-orders.js';
export * from './hotel-control.js';
export * from './marketing.js';
export * from './order-change-requests.js';
export * from './orders.js';
export * from './payment-channels.js';
export * from './payments.js';
export * from './pricing.js';
export * from './products.js';
export * from './receipts.js';
export * from './reminders.js';
export * from './reviews.js';
export * from './seat-allocation.js';
export * from './seat-locks.js';
export * from './settlement-discounts.js';
export * from './settlement-rates.js';
export * from './settlement-requests.js';
export * from './settlements.js';
export * from './travelers.js';
export * from './waitlist.js';

/**
 * 真撞名的符号在这里显式定夺，其余的按模块子路径导入。
 *
 * bundleItemSchema 两边都有，是两件不同的东西：orders 那份是**录单时的一条套餐行**
 *（带乘客、房型、加购），products 那份是**套餐定义里的一条内容行**（酒店/签证/机票组成）。
 * 名字撞了但语义不该合并，所以桶文件只放订单那份（调用面大得多），要产品那份就写
 * `import { bundleItemSchema } from '@ftm/contracts/products'`。
 */
export { bundleItemSchema } from './orders.js';
