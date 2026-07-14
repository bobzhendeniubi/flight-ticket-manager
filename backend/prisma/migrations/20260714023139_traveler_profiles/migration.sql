-- CreateTable
CREATE TABLE "TravelerProfile" (
    "id" TEXT NOT NULL,
    "documentType" "DocumentType" NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "chineseName" TEXT,
    "gender" "Gender",
    "dateOfBirth" TIMESTAMP(3),
    "nationality" TEXT,
    "passportExpiry" DATE,
    "tripCount" INTEGER NOT NULL DEFAULT 0,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "firstTripAt" TIMESTAMP(3),
    "lastTripAt" TIMESTAMP(3),
    "nextTripAt" TIMESTAMP(3),
    "totalSpendCny" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "prefCabin" "CabinClass",
    "prefBed" TEXT,
    "prefMeal" TEXT,
    "prefSingleRoom" BOOLEAN NOT NULL DEFAULT false,
    "needsWheelchair" BOOLEAN NOT NULL DEFAULT false,
    "hotelHistory" JSONB NOT NULL DEFAULT '[]',
    "companions" JSONB NOT NULL DEFAULT '[]',
    "linkedUserId" TEXT,
    "notes" TEXT,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TravelerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TravelerProfile_fullName_idx" ON "TravelerProfile"("fullName");

-- CreateIndex
CREATE INDEX "TravelerProfile_lastTripAt_idx" ON "TravelerProfile"("lastTripAt");

-- CreateIndex
CREATE INDEX "TravelerProfile_tripCount_idx" ON "TravelerProfile"("tripCount");

-- CreateIndex
CREATE UNIQUE INDEX "TravelerProfile_documentType_documentNumber_key" ON "TravelerProfile"("documentType", "documentNumber");
