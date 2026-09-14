-- CreateEnum
CREATE TYPE "SharedRoomStatus" AS ENUM ('ACTIVE', 'DISSOLVED');

-- CreateTable
CREATE TABLE "SharedRoom" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "hotelRoomTypeId" TEXT NOT NULL,
    "checkIn" DATE NOT NULL,
    "checkOut" DATE NOT NULL,
    "status" "SharedRoomStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "dissolvedAt" TIMESTAMP(3),
    "dissolvedReason" TEXT,

    CONSTRAINT "SharedRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharedRoomMember" (
    "id" TEXT NOT NULL,
    "sharedRoomId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "passengerId" TEXT NOT NULL,
    "roomFraction" DECIMAL(4,1) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SharedRoomMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SharedRoomRequest" (
    "id" TEXT NOT NULL,
    "requestToken" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "resultJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SharedRoomRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SharedRoom_hotelId_checkIn_checkOut_idx" ON "SharedRoom"("hotelId", "checkIn", "checkOut");

-- CreateIndex
CREATE INDEX "SharedRoom_status_idx" ON "SharedRoom"("status");

-- CreateIndex
CREATE INDEX "SharedRoomMember_sharedRoomId_idx" ON "SharedRoomMember"("sharedRoomId");

-- CreateIndex
CREATE INDEX "SharedRoomMember_orderId_idx" ON "SharedRoomMember"("orderId");

-- CreateIndex
CREATE INDEX "SharedRoomMember_orderItemId_idx" ON "SharedRoomMember"("orderItemId");

-- CreateIndex
CREATE INDEX "SharedRoomMember_passengerId_idx" ON "SharedRoomMember"("passengerId");

-- CreateIndex
CREATE UNIQUE INDEX "SharedRoomMember_sharedRoomId_passengerId_key" ON "SharedRoomMember"("sharedRoomId", "passengerId");

-- CreateIndex
CREATE UNIQUE INDEX "SharedRoomRequest_requestToken_key" ON "SharedRoomRequest"("requestToken");

-- CreateIndex
CREATE INDEX "SharedRoomRequest_createdAt_idx" ON "SharedRoomRequest"("createdAt");

-- AddForeignKey
ALTER TABLE "SharedRoom" ADD CONSTRAINT "SharedRoom_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedRoom" ADD CONSTRAINT "SharedRoom_hotelRoomTypeId_fkey" FOREIGN KEY ("hotelRoomTypeId") REFERENCES "HotelRoomType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedRoomMember" ADD CONSTRAINT "SharedRoomMember_sharedRoomId_fkey" FOREIGN KEY ("sharedRoomId") REFERENCES "SharedRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedRoomMember" ADD CONSTRAINT "SharedRoomMember_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedRoomMember" ADD CONSTRAINT "SharedRoomMember_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SharedRoomMember" ADD CONSTRAINT "SharedRoomMember_passengerId_fkey" FOREIGN KEY ("passengerId") REFERENCES "Passenger"("id") ON DELETE CASCADE ON UPDATE CASCADE;
