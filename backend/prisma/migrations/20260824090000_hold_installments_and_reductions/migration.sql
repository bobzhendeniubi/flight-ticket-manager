-- 占位单二期：收款计划、挂账池认款、逾期与减员清算。

CREATE TYPE "HoldInstallmentStatus" AS ENUM ('PENDING', 'PAID');
CREATE TYPE "HoldAmountRule" AS ENUM ('PER_PERSON_FIXED', 'REMAINDER');
CREATE TYPE "HoldOverdueAction" AS ENUM ('REMIND_ONLY', 'AUTO_RELEASE');
CREATE TYPE "HoldOccupyOn" AS ENUM ('CREATE', 'FULL_PAYMENT');

ALTER TABLE "HoldOrder"
  ADD COLUMN "occupyOn" "HoldOccupyOn" NOT NULL DEFAULT 'CREATE';

-- 二期开始金融历史禁止随班次/舱位硬删；历史占位单也必须先停用保留。
ALTER TABLE "HoldOrder" DROP CONSTRAINT "HoldOrder_flightScheduleId_fkey";
ALTER TABLE "HoldOrder" DROP CONSTRAINT "HoldOrder_seatClassId_fkey";
ALTER TABLE "HoldOrder"
  ADD CONSTRAINT "HoldOrder_flightScheduleId_fkey"
  FOREIGN KEY ("flightScheduleId") REFERENCES "FlightSchedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HoldOrder"
  ADD CONSTRAINT "HoldOrder_seatClassId_fkey"
  FOREIGN KEY ("seatClassId") REFERENCES "FlightSeatClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "HoldInstallment" (
  "id" TEXT NOT NULL,
  "holdOrderId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "label" TEXT NOT NULL,
  "amountRule" "HoldAmountRule" NOT NULL,
  "perPersonCny" INTEGER,
  "amountCny" INTEGER NOT NULL,
  "seatsBasis" INTEGER NOT NULL,
  "dueDate" DATE NOT NULL,
  "status" "HoldInstallmentStatus" NOT NULL DEFAULT 'PENDING',
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HoldInstallment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HoldInstallment_holdOrderId_seq_key"
  ON "HoldInstallment"("holdOrderId", "seq");
CREATE INDEX "HoldInstallment_status_dueDate_idx"
  ON "HoldInstallment"("status", "dueDate");

CREATE TABLE "HoldReceiptAllocation" (
  "id" TEXT NOT NULL,
  "receiptId" TEXT NOT NULL,
  "holdOrderId" TEXT NOT NULL,
  "holdInstallmentId" TEXT NOT NULL,
  "amountCny" DECIMAL(14,2) NOT NULL,
  "reversedAt" TIMESTAMP(3),
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HoldReceiptAllocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HoldReceiptAllocation_receiptId_idx"
  ON "HoldReceiptAllocation"("receiptId");
CREATE INDEX "HoldReceiptAllocation_holdOrderId_idx"
  ON "HoldReceiptAllocation"("holdOrderId");

CREATE TABLE "HoldReductionRecord" (
  "id" TEXT NOT NULL,
  "holdOrderId" TEXT NOT NULL,
  "seatsReduced" INTEGER NOT NULL,
  "freeSeats" INTEGER NOT NULL,
  "forfeitSeats" INTEGER NOT NULL,
  "perSeatPaidCny" INTEGER NOT NULL,
  "forfeitCny" INTEGER NOT NULL,
  "creditCny" INTEGER NOT NULL,
  "surplusCny" INTEGER NOT NULL DEFAULT 0,
  "note" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HoldReductionRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HoldReductionRecord_holdOrderId_idx"
  ON "HoldReductionRecord"("holdOrderId");

CREATE TABLE "HoldOrderConfig" (
  "id" TEXT NOT NULL,
  "installments" JSONB NOT NULL,
  "overdueAction" "HoldOverdueAction" NOT NULL DEFAULT 'REMIND_ONLY',
  "defaultFreeCancelRatio" DECIMAL(4,3) NOT NULL DEFAULT 0.1,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HoldOrderConfig_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "HoldInstallment"
  ADD CONSTRAINT "HoldInstallment_holdOrderId_fkey"
  FOREIGN KEY ("holdOrderId") REFERENCES "HoldOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HoldReceiptAllocation"
  ADD CONSTRAINT "HoldReceiptAllocation_receiptId_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HoldReceiptAllocation"
  ADD CONSTRAINT "HoldReceiptAllocation_holdOrderId_fkey"
  FOREIGN KEY ("holdOrderId") REFERENCES "HoldOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HoldReceiptAllocation"
  ADD CONSTRAINT "HoldReceiptAllocation_holdInstallmentId_fkey"
  FOREIGN KEY ("holdInstallmentId") REFERENCES "HoldInstallment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HoldReductionRecord"
  ADD CONSTRAINT "HoldReductionRecord_holdOrderId_fkey"
  FOREIGN KEY ("holdOrderId") REFERENCES "HoldOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 存量一期占位单没有收款期时补一条全款期；只处理缺期数据，重复执行不会重复插入。
INSERT INTO "HoldInstallment" (
  "id", "holdOrderId", "seq", "label", "amountRule", "perPersonCny",
  "amountCny", "seatsBasis", "dueDate", "status", "paidAt", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  h."id",
  1,
  '全款',
  'REMAINDER'::"HoldAmountRule",
  NULL,
  h."seats" * h."perSeatPriceCny",
  h."seats",
  CURRENT_DATE,
  -- 与运行时口径一致：0 元期（零价占位）视同已结清，不留永远收不满的 PENDING 期。
  CASE WHEN h."status" = 'FULLY_PAID'::"HoldOrderStatus" OR h."seats" * h."perSeatPriceCny" = 0
    THEN 'PAID'::"HoldInstallmentStatus"
    ELSE 'PENDING'::"HoldInstallmentStatus"
  END,
  CASE WHEN h."status" = 'FULLY_PAID'::"HoldOrderStatus" OR h."seats" * h."perSeatPriceCny" = 0
    THEN CURRENT_TIMESTAMP ELSE NULL END,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "HoldOrder" h
WHERE NOT EXISTS (
  SELECT 1 FROM "HoldInstallment" i WHERE i."holdOrderId" = h."id"
);
