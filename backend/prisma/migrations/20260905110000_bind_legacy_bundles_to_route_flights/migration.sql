-- 存量套餐绑到旧航线的航班 —— 开第二条线前的一次性数据回填。
--
-- 背景：系统只有一条航线（澳门 MFM ⇌ 岘港 DAD）的时代，套餐不绑航班也能卖：可售日期 / 录单 /
-- 结算价都按写死的航线取数。新口径改为「套餐的航线 = 套餐绑定航班的航线，没绑航班 = 没航线 =
-- 不可售、不取日历价」（bundle-route.ts，代码里绝不兜底）。代码不兜底是对的，但存量套餐
-- 是在旧规则下建的、事实上一直卖的就是这条线，不能因为换口径就整批下架。
--
-- 做法：只回填「去程和回程都没绑」的套餐；且仅当旧航线每个方向恰好只有一个在用航班时才自动绑
--（此时绑定没有歧义：老逻辑本来就只会命中这一班）。任一方向 0 个或多于 1 个在用航班 → 本迁移
-- 什么都不做，留给运营在「产品 · 套餐」里手工绑定（部署前清单会列出未绑套餐）。
-- 只绑了一段的套餐不动：bundle-route 会按已绑的那段派生航线。
-- 幂等：重复执行时 WHERE 条件不再命中。回滚：不需要（只是把 NULL 填成航班 id，可手工清空）。

UPDATE "Bundle" AS b
SET "outboundFlightId" = o.id,
    "returnFlightId"   = r.id
FROM (SELECT id FROM "Flight" WHERE "originCode" = 'MFM' AND "destinationCode" = 'DAD' AND "isActive") AS o,
     (SELECT id FROM "Flight" WHERE "originCode" = 'DAD' AND "destinationCode" = 'MFM' AND "isActive") AS r
WHERE b."outboundFlightId" IS NULL
  AND b."returnFlightId" IS NULL
  AND (SELECT count(*) FROM "Flight" WHERE "originCode" = 'MFM' AND "destinationCode" = 'DAD' AND "isActive") = 1
  AND (SELECT count(*) FROM "Flight" WHERE "originCode" = 'DAD' AND "destinationCode" = 'MFM' AND "isActive") = 1;
