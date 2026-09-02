-- 订单航段留痕物化列 legFlag（去程 no-show / 回程已释放 / 已恢复 / 去程或回程已作废）。
--
-- 为什么要物化：这几态的真源是 FLIGHT 行 metadata 里的快照（noShow / returnReleased /
-- returnRestored / returnVoidedFinal / returnLegCancelled），Prisma 的 where 表达不了「关联行的
-- JSON 里某个键存在且比另一个键新」，列表与导出因此根本筛不出「今天释放了哪些回程」。
-- 由 syncOrderLegFlag 在所有落 no-show / 释放 / 恢复 / 取消航段 / 拆单 / 改期的事务内
-- 与 hasReturnLeg 成对维护。
--
-- 新列默认 NONE；下面对**取消航段**的存量单做一次回填 —— 取消航段功能早于本列上线，
-- 那批单的 metadata 里已经有 returnLegCancelled 快照，不回填的话它们会一直停在 NONE，
-- 而导出列「航段状态」按快照现算已经写着「已作废」，同一张单在筛选与导出里对不上。
-- （no-show / 释放 / 恢复三态本列上线时线上尚无任何单，无需回填。）

-- CreateEnum
CREATE TYPE "OrderLegFlag" AS ENUM ('NONE', 'NO_SHOW', 'RETURN_RELEASED', 'RETURN_RESTORED', 'RETURN_VOIDED', 'OUTBOUND_VOIDED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "legFlag" "OrderLegFlag" NOT NULL DEFAULT 'NONE';

-- CreateIndex
CREATE INDEX "Order_legFlag_idx" ON "Order"("legFlag");

-- Backfill：存量「取消航段」单按快照里的 leg 方向回填（OUTBOUND → 去程作废，其余 → 回程作废）。
-- 一张单可能两段都被取消过（先取消回程、再取消去程）：DISTINCT ON 让 OUTBOUND 那行优先，
-- 与 deriveLegStatus 的优先级和 syncOrderLegFlag 的映射一致。
-- 回填只认取消航段这一态；漏网或事后漂移由 backend/scripts/sync-order-leg-flag.ts 幂等自愈。
UPDATE "Order" AS o
SET "legFlag" = v."flag"::"OrderLegFlag"
FROM (
  SELECT DISTINCT ON (i."orderId")
    i."orderId" AS "orderId",
    CASE
      WHEN i."metadata" -> 'returnLegCancelled' ->> 'leg' = 'OUTBOUND' THEN 'OUTBOUND_VOIDED'
      ELSE 'RETURN_VOIDED'
    END AS "flag"
  FROM "OrderItem" i
  WHERE i."kind" = 'FLIGHT'
    AND i."metadata" -> 'returnLegCancelled' IS NOT NULL
  ORDER BY i."orderId", (i."metadata" -> 'returnLegCancelled' ->> 'leg') = 'OUTBOUND' DESC, i."id"
) AS v
WHERE o."id" = v."orderId";
