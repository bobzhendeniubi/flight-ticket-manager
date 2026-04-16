-- CreateTable
CREATE TABLE "DateRanking" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "rank" TEXT NOT NULL,
    "reason" TEXT,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DateRanking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DateRanking_date_key" ON "DateRanking"("date");

-- CreateIndex
CREATE INDEX "DateRanking_date_idx" ON "DateRanking"("date");
