-- 按乘客调价（0722 公测反馈）：给价格调整 OrderItem 行挂可空 passengerId。
-- NULL = 整单调价（现行为不变）；非空 = 只作用于该乘客的应收份额（金额明细逐人可解释）。
-- onDelete: SetNull —— 乘客被清除时不丢金额（差额仍留在 total），只失去归属。

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN "passengerId" TEXT;

-- CreateIndex
CREATE INDEX "OrderItem_passengerId_idx" ON "OrderItem"("passengerId");

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_passengerId_fkey" FOREIGN KEY ("passengerId") REFERENCES "Passenger"("id") ON DELETE SET NULL ON UPDATE CASCADE;
