-- 乘客曾用身份（换人/改信息前的姓名+证件号），供订单搜索召回换前的人
ALTER TABLE "Passenger" ADD COLUMN "formerIdentities" TEXT;
