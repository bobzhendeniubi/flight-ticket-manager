-- 常旅客号 travelerNo + 档案合并指针 mergedIntoId
--
-- travelerNo 不能直接用 SERIAL：SERIAL 按物理行序发号，存量回填顺序无意义。
-- 手写四步：加空列 → 按「老客号小」回填（firstTripAt 早的优先，无出行记录的按建档时间排队）
-- → 锁 NOT NULL → 建序列接管后续发号（setval 到 max+1，OWNED BY 对齐 SERIAL 语义，防 schema drift）。

-- AlterTable：先加 nullable 列（存量行待回填）
ALTER TABLE "TravelerProfile" ADD COLUMN "travelerNo" INTEGER,
ADD COLUMN "mergedIntoId" TEXT;

-- 存量回填：老客号小 —— firstTripAt 升序（NULL 排最后），同批按 createdAt 升序兜底
WITH ordered AS (
  SELECT "id",
         ROW_NUMBER() OVER (ORDER BY "firstTripAt" ASC NULLS LAST, "createdAt" ASC) AS rn
  FROM "TravelerProfile"
)
UPDATE "TravelerProfile" t
SET "travelerNo" = ordered.rn
FROM ordered
WHERE t."id" = ordered."id";

-- 回填完毕，锁非空
ALTER TABLE "TravelerProfile" ALTER COLUMN "travelerNo" SET NOT NULL;

-- 序列接管后续发号：setval 到 max+1（is_called=false → 下一次 nextval 正好是 max+1）
CREATE SEQUENCE "TravelerProfile_travelerNo_seq";
SELECT setval('"TravelerProfile_travelerNo_seq"', COALESCE((SELECT MAX("travelerNo") FROM "TravelerProfile"), 0) + 1, false);
ALTER TABLE "TravelerProfile" ALTER COLUMN "travelerNo" SET DEFAULT nextval('"TravelerProfile_travelerNo_seq"');
-- OWNED BY 与 SERIAL 行为一致（删表/删列时级联删序列），也让 prisma 漂移检测认账
ALTER SEQUENCE "TravelerProfile_travelerNo_seq" OWNED BY "TravelerProfile"."travelerNo";

-- CreateIndex
CREATE UNIQUE INDEX "TravelerProfile_travelerNo_key" ON "TravelerProfile"("travelerNo");

-- CreateIndex
CREATE INDEX "TravelerProfile_mergedIntoId_idx" ON "TravelerProfile"("mergedIntoId");
