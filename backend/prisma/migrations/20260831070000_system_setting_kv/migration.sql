-- 运营可自调的系统开关（通用键值）。纯增表，不动既有数据。
-- 首个键 = hotelMaxOversellRooms（酒店超售容忍上限，房控页可改；无记录回落 env 缺省）。
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);
