-- 订单号发号计数器：一行 = 一个北京业务日，单号 = FTM + 业务日 + 5 位序号（00001 起）。
-- 取代原来的「日期 + 5 位随机数」：一天只有 9 万个号，按生日悖论 200 单/天约两成概率撞出同号，
-- 撞上时 Order.orderNumber 唯一约束抛 P2002，建单 / 占位转正直接失败。
-- 存量单号不动：旧随机后五位 ≥ 10000，新序号从 00001 起，切换当天也不会撞。
-- CreateTable
CREATE TABLE "OrderNumberCounter" (
    "businessDate" DATE NOT NULL,
    "nextSeq" INTEGER NOT NULL,

    CONSTRAINT "OrderNumberCounter_pkey" PRIMARY KEY ("businessDate")
);
