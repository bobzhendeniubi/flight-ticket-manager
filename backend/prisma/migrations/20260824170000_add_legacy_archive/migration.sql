-- Legacy archive is intentionally independent from all live business tables.
CREATE TABLE "LegacyFlight" (
    "id" TEXT NOT NULL,
    "flightNo" TEXT,
    "departDate" DATE,
    "departTime" TEXT,
    "arriveTime" TEXT,
    "originCode" TEXT,
    "destCode" TEXT,
    "businessTotal" INTEGER,
    "economyTotal" INTEGER,
    "adultBusinessPrice" DECIMAL(12,2),
    "adultEconomyPrice" DECIMAL(12,2),
    "isProduct" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "LegacyFlight_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LegacyTicket" (
    "id" TEXT NOT NULL,
    "bookingNo" TEXT,
    "teamNo" TEXT,
    "tripType" INTEGER,
    "cabinLevel" INTEGER,
    "fullName" TEXT,
    "chineseName" TEXT,
    "documentName" TEXT,
    "gender" TEXT,
    "birthDate" DATE,
    "nationality" TEXT,
    "documentTypeRaw" TEXT,
    "documentNumber" TEXT,
    "documentNumberNorm" TEXT,
    "issueDate" DATE,
    "expiryDate" DATE,
    "birthPlace" TEXT,
    "passengerType" TEXT,
    "infantAdultName" TEXT,
    "finalPrice" DECIMAL(12,2),
    "truePrice" DECIMAL(12,2),
    "depositPrice" DECIMAL(12,2),
    "hotelPrice" DECIMAL(12,2),
    "hotelTruePrice" DECIMAL(12,2),
    "visaPrice" DECIMAL(12,2),
    "visaTruePrice" DECIMAL(12,2),
    "discountPrice" DECIMAL(12,2),
    "deductionPrice" DECIMAL(12,2),
    "finalPriceRemark" TEXT,
    "paymentConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "stateRaw" INTEGER,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "outboundTicketed" BOOLEAN NOT NULL DEFAULT false,
    "returnTicketed" BOOLEAN NOT NULL DEFAULT false,
    "systemTicketed" BOOLEAN NOT NULL DEFAULT false,
    "visaStateRaw" INTEGER,
    "hotelTypeName" TEXT,
    "orgId" TEXT,
    "orgName" TEXT,
    "remark" TEXT,
    "fileId" TEXT,
    "paymentFileId" TEXT,
    "legacyCreateTime" TIMESTAMP(3),
    "legacyUpdateTime" TIMESTAMP(3),
    "outboundFlightNo" TEXT,
    "outboundDate" DATE,
    "returnFlightNo" TEXT,
    "returnDate" DATE,
    "supersededByOrderId" TEXT,
    "dataIssues" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "LegacyTicket_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LegacyTicketFlight" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "flightId" TEXT NOT NULL,
    "legType" INTEGER NOT NULL,

    CONSTRAINT "LegacyTicketFlight_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LegacyTicketFlight_ticketId_fkey"
      FOREIGN KEY ("ticketId") REFERENCES "LegacyTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LegacyTicketFlight_flightId_fkey"
      FOREIGN KEY ("flightId") REFERENCES "LegacyFlight"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "LegacyReceipt" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT,
    "sequence" INTEGER,
    "amount" DECIMAL(12,2),
    "receivedAt" TIMESTAMP(3),
    "channelCode" INTEGER,
    "legacyCreateTime" TIMESTAMP(3),

    CONSTRAINT "LegacyReceipt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LegacyFlight_flightNo_departDate_idx" ON "LegacyFlight"("flightNo", "departDate");
CREATE INDEX "LegacyTicket_documentNumberNorm_idx" ON "LegacyTicket"("documentNumberNorm");
CREATE INDEX "LegacyTicket_fullName_idx" ON "LegacyTicket"("fullName");
CREATE INDEX "LegacyTicket_chineseName_idx" ON "LegacyTicket"("chineseName");
CREATE INDEX "LegacyTicket_bookingNo_idx" ON "LegacyTicket"("bookingNo");
CREATE INDEX "LegacyTicket_teamNo_idx" ON "LegacyTicket"("teamNo");
CREATE INDEX "LegacyTicket_legacyCreateTime_idx" ON "LegacyTicket"("legacyCreateTime");
CREATE INDEX "LegacyTicket_outboundDate_idx" ON "LegacyTicket"("outboundDate");
CREATE INDEX "LegacyTicketFlight_ticketId_idx" ON "LegacyTicketFlight"("ticketId");
CREATE INDEX "LegacyTicketFlight_flightId_idx" ON "LegacyTicketFlight"("flightId");
CREATE INDEX "LegacyReceipt_ticketId_idx" ON "LegacyReceipt"("ticketId");
CREATE INDEX "LegacyReceipt_receivedAt_idx" ON "LegacyReceipt"("receivedAt");
