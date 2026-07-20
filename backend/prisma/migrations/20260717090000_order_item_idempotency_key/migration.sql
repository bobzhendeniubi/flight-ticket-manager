-- 补房差等事后追加 FEE 行的幂等键：同 key 重试只入账一次，防双击/网络重发叠加多条 FEE。
ALTER TABLE "OrderItem" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "OrderItem_idempotencyKey_key" ON "OrderItem"("idempotencyKey");
