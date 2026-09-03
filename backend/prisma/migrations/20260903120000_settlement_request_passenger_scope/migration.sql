-- 议价申请支持「指定乘客」作用范围（代理在订单详情页也能分乘客改价，与录单按人填结算价对齐）。
-- 纯新增三列、全部可空：存量行 passengerId 为 NULL = 整单申请，老行为一字不变。
--   passengerId            作用范围（与事后调价 OrderItem.passengerId 同口径；不建 FK，乘客可能被换人/拆单挪走）
--   passengerName          提交时的姓名快照，乘客被挪走后历史申请仍读得出改的是谁
--   requestedAdjustmentCny 指定乘客时申请的调整净额（正=补收 / 负=优惠）；整单申请为 NULL

-- AlterTable
ALTER TABLE "SettlementRequest"
  ADD COLUMN "passengerId" TEXT,
  ADD COLUMN "passengerName" TEXT,
  ADD COLUMN "requestedAdjustmentCny" DECIMAL(12,2);
