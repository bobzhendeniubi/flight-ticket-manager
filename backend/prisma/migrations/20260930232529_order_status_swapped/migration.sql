-- 订单状态新增「已换人」（SWAPPED）：只加枚举值，不动任何列、不回填。
-- 进入该状态的唯一正门是 POST /orders/:id/mark-swapped（应收收敛到换人费 + 多付转存 + 释放座位）。
-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'SWAPPED';
