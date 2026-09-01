-- 换人退款结构化标记；三列均为纯新增，不改动既有订单数据。
ALTER TABLE "Order" ADD COLUMN "swapRefundedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "swapFeeCny" INTEGER;
ALTER TABLE "Order" ADD COLUMN "swapReplacementOrderNumber" TEXT;
