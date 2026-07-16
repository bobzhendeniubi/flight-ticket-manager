-- 开票上限改为派生自真实座位库存：上限 = Σ FlightSeatClass.capacity（多少商务舱 + 多少经济舱）。
--
-- 背景：FlightSchedule.ticketingCap 默认 191，无任何出处，且与 FlightSeatClass 的真实座位数
-- 从不对账 —— 卖票一直按 FlightSeatClass 扣，开票却另按这个常量把关，两本账。
-- 现口径：每个班次配置能卖多少张即 inventory，开票上限就是它；本列失去意义，直接删。
--
-- 数据影响：纯删列，不迁移任何数据。既有的自定义上限值（若运营改过）一并丢弃 ——
-- 这是有意的：新口径下上限只能是座位数，任何偏离座位数的历史值都是要消灭的第二本账。
ALTER TABLE "FlightSchedule" DROP COLUMN "ticketingCap";
