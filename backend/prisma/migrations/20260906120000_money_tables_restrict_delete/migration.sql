-- C-23：资金子表不许跟着订单/代理硬删丢失历史。
-- 之前 Payment/Refund → Order 与 PrepaymentTransaction/CommissionRule/SettlementDiscountRule → Agent
-- 都是 ON DELETE CASCADE：团队有过硬删账号/订单的先例（见 0824 账号批），硬删会把收款、退款、
-- 预存款流水、返佣费率、结算价立减规则一并清空，钱去哪了从此在库里找不到痕迹。
-- 改成 RESTRICT：要删订单/代理必须先处理完它名下的资金记录（软删 deletedAt / 停用 isActive 不受影响，
-- 同类先例见 20260824090000_hold_installments_and_reductions 把 HoldOrder 的两个外键改 RESTRICT）。

ALTER TABLE "Payment" DROP CONSTRAINT "Payment_orderId_fkey";
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Refund" DROP CONSTRAINT "Refund_orderId_fkey";
ALTER TABLE "Refund"
  ADD CONSTRAINT "Refund_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PrepaymentTransaction" DROP CONSTRAINT "PrepaymentTransaction_agentId_fkey";
ALTER TABLE "PrepaymentTransaction"
  ADD CONSTRAINT "PrepaymentTransaction_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommissionRule" DROP CONSTRAINT "CommissionRule_agentId_fkey";
ALTER TABLE "CommissionRule"
  ADD CONSTRAINT "CommissionRule_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SettlementDiscountRule" DROP CONSTRAINT "SettlementDiscountRule_agentId_fkey";
ALTER TABLE "SettlementDiscountRule"
  ADD CONSTRAINT "SettlementDiscountRule_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
