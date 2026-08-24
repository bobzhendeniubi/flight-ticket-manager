-- 占位单三期：名单转正来源关系、转正流水。

ALTER TABLE "Order" ADD COLUMN "sourceHoldOrderId" TEXT;

CREATE TABLE "HoldConversionRecord" (
    "id" TEXT NOT NULL,
    "holdOrderId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "carryCny" INTEGER NOT NULL,
    "paymentId" TEXT,
    "requestToken" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HoldConversionRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Order_sourceHoldOrderId_idx" ON "Order"("sourceHoldOrderId");
CREATE INDEX "HoldConversionRecord_holdOrderId_idx" ON "HoldConversionRecord"("holdOrderId");
CREATE INDEX "HoldConversionRecord_orderId_idx" ON "HoldConversionRecord"("orderId");
CREATE INDEX "HoldConversionRecord_paymentId_idx" ON "HoldConversionRecord"("paymentId");
CREATE UNIQUE INDEX "HoldConversionRecord_holdOrderId_requestToken_key"
  ON "HoldConversionRecord"("holdOrderId", "requestToken");

ALTER TABLE "Order"
  ADD CONSTRAINT "Order_sourceHoldOrderId_fkey"
  FOREIGN KEY ("sourceHoldOrderId") REFERENCES "HoldOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "HoldConversionRecord"
  ADD CONSTRAINT "HoldConversionRecord_holdOrderId_fkey"
  FOREIGN KEY ("holdOrderId") REFERENCES "HoldOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HoldConversionRecord"
  ADD CONSTRAINT "HoldConversionRecord_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
