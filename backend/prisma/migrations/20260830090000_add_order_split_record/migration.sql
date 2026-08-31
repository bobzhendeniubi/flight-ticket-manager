-- CreateTable
CREATE TABLE "OrderSplitRecord" (
    "id" TEXT NOT NULL,
    "sourceOrderId" TEXT NOT NULL,
    "targetOrderId" TEXT NOT NULL,
    "passengerCount" INTEGER NOT NULL,
    "movedShareCny" DECIMAL(12,2) NOT NULL,
    "movedPaidCny" DECIMAL(12,2) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "requestToken" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderSplitRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderSplitRecord_sourceOrderId_idx" ON "OrderSplitRecord"("sourceOrderId");

-- CreateIndex
CREATE INDEX "OrderSplitRecord_targetOrderId_idx" ON "OrderSplitRecord"("targetOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderSplitRecord_sourceOrderId_requestToken_key" ON "OrderSplitRecord"("sourceOrderId", "requestToken");

-- AddForeignKey
ALTER TABLE "OrderSplitRecord" ADD CONSTRAINT "OrderSplitRecord_sourceOrderId_fkey" FOREIGN KEY ("sourceOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderSplitRecord" ADD CONSTRAINT "OrderSplitRecord_targetOrderId_fkey" FOREIGN KEY ("targetOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

