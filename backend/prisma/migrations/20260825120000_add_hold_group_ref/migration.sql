-- 占位单团号：同一个团的多个航段（去程 / 回程 / 多段）共享一个团号。
--
-- 此前一张占位单 = 一个班次，团队的去回程在库里是两条毫无关联的记录，
-- 既无法回答「这个团留了哪几天」，也无法在导出里按团核对是否漏留 / 留错。
-- 加团号后，建单一次可覆盖多个航段并落同一个 groupRef；单航段建单同样落号，
-- 保证「按团查」只有一个口径。
--
-- 纯增可空列 + 索引，不回填、不改既有行为：存量占位单 groupRef 为 NULL，
-- 按班次查询与库存聚合（seats − seatsConverted − seatsCancelled）完全不受影响。
ALTER TABLE "HoldOrder" ADD COLUMN IF NOT EXISTS "groupRef" TEXT;
CREATE INDEX IF NOT EXISTS "HoldOrder_groupRef_idx" ON "HoldOrder"("groupRef");
