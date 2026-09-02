-- 订单航段留痕物化列 legFlag（去程 no-show / 回程已释放 / 已恢复 / 已作废）。
--
-- 为什么要物化：四态的真源是 FLIGHT 行 metadata 里的快照（noShow / returnReleased /
-- returnRestored / returnVoidedFinal），Prisma 的 where 表达不了「关联行的 JSON 里某个键存在
-- 且比另一个键新」，列表与导出因此根本筛不出「今天释放了哪些回程」。
-- 由 syncOrderLegFlag 在所有落 no-show / 释放 / 恢复 / 拆单 / 改期的事务内与 hasReturnLeg 成对维护。
--
-- 纯增列：默认 NONE，不回填 —— 本列上线时线上尚无任何 no-show 单，存量全部就是 NONE。

-- CreateEnum
CREATE TYPE "OrderLegFlag" AS ENUM ('NONE', 'NO_SHOW', 'RETURN_RELEASED', 'RETURN_RESTORED', 'RETURN_VOIDED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "legFlag" "OrderLegFlag" NOT NULL DEFAULT 'NONE';

-- CreateIndex
CREATE INDEX "Order_legFlag_idx" ON "Order"("legFlag");
