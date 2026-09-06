-- 一张订单对同一个产品只允许一条评价。
-- 应用层已在 createOrderReview 里 catch P2002 回 409，但那只防得住走这一条代码路径的调用；
-- 唯一索引让「同一单同一产品两条评价」在任何路径（并发、其它入口、直连库）下都落不进去。

-- 1) 先清历史重复行：同 (orderId, productType, productId) 只留最早的一条，其余删掉。
--    评价是纯展示数据，重复行本身就是重复提交/刷出来的，不另留档案表。
DELETE FROM "Review" r
USING "Review" keep
WHERE r."orderId" IS NOT NULL
  AND keep."orderId" = r."orderId"
  AND keep."productType" = r."productType"
  AND keep."productId" = r."productId"
  AND (keep."createdAt", keep."id") < (r."createdAt", r."id");

-- 2) 建唯一索引。
--    orderId 可空（非订单来源的评价）—— Postgres 唯一索引里 NULL 互不相等，这些行天然不受约束，
--    所以不必写成 WHERE "orderId" IS NOT NULL 的部分索引；用 Prisma @@unique 的标准命名，
--    schema.prisma 与库结构保持一致，不留漂移（部分索引写不进 @@unique，会被后续 migrate 判成缺索引）。
CREATE UNIQUE INDEX "Review_orderId_productType_productId_key"
  ON "Review" ("orderId", "productType", "productId");
