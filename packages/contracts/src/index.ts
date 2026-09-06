/**
 * @ftm/contracts —— 前后端契约的唯一事实源
 *
 * 这里放三类东西：
 *   1. Prisma 枚举镜像（enums.ts）；
 *   2. 请求体 / 查询参数的 zod schema（按后端模块分文件）；
 *   3. 响应 DTO 的类型（纯 TS type，**不在后端响应路径上做 parse**，只做类型约束）。
 *
 * 后端 `*.schemas.ts` 改成 `export * from '@ftm/contracts/<module>'`，所有既有 import
 * 路径保持可用；前端 `api.ts` 用 `import type { … } from '@ftm/contracts'` 取同一份类型，
 * 不再手抄。加新端点的流程见 docs/前后端契约.md。
 *
 * 桶文件只 re-export，不定义任何东西。
 */
export {};
