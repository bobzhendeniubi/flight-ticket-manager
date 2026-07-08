-- AlterTable
-- Passenger.dateOfBirth 由必填改为可空。
-- 动机：换人（swapPassenger）检测到证件号变化=真换人时，需清除旧出行人残留的
--   护照/签证/出生地信息；生日此前为 NOT NULL 无法置空，导致新出行人套用前一位的生日。
-- 建单入口仍强制要求生日（zod passengerInputSchema），可空只服务「换人清除」这一场景。
-- 纯放宽约束（DROP NOT NULL），不改列类型、不动存量数据。
ALTER TABLE "Passenger" ALTER COLUMN "dateOfBirth" DROP NOT NULL;
