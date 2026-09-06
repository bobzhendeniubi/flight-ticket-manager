-- 随机档按城市圈定：城市的事实源 = "Hotel"."cityCode"。
-- 本迁移只回填数据、不改列定义（cityCode 本就是 NOT NULL 的文本列）。
--
-- 1) 归一：去首尾空白 + 大写。随机档聚合按 (cityCode, starRating) 等值匹配，
--    'dad' / 'DAD ' 若不归一会被当成另一个城市，同城同星的房量就被拆成两个池子。
UPDATE "Hotel"
SET "cityCode" = upper(btrim("cityCode"))
WHERE "cityCode" <> upper(btrim("cityCode"));

-- 2) 存量默认城市：城市为空（含空白）的酒店回填 DAD（岘港）。
--    上线前业务只在岘港，这里面最要紧的是随机档占位酒店（randomTierPlaceholder 非空）——
--    套餐绑在它们的房型上、它们的城市就是套餐的城市；此后占位酒店的 cityCode 由应用层守卫必填。
UPDATE "Hotel"
SET "cityCode" = 'DAD'
WHERE btrim("cityCode") = '';
