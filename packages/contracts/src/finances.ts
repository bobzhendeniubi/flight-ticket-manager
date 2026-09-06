/**
 * 财务模块入参校验（从 finances.routes.ts 的内联 schema 搬进契约包）。
 */
import { z } from 'zod';

/**
 * 成本快照回填：limit 缺省 = 全量；apply 缺省 false（只算不写，先看清楚要补多少行再动手）。
 * 查询参数走字符串，所以 apply 用 'true' / 'false' 再转布尔。
 */
export const costBackfillQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100_000).optional(),
  apply: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
export type CostBackfillQuery = z.infer<typeof costBackfillQuerySchema>;
