-- FlightSchedule.checkinCloseMinutes —— 关柜提前分钟数（起飞前多少分钟关闭值机柜台）。
--
-- 为什么要它：no-show 的判定锚点原本是「起飞时刻」，运营要等到飞机真的推出去那一刻才能标记；
-- 而实际业务里柜台一关（国内惯例提前 45 分钟）客人就上不去了，那时就该按 no-show 处理。
-- 做成可空的每班次覆盖值：绝大多数班次不填，走系统默认 45（见 backend/src/lib/checkin-close.ts）；
-- 个别包机/口岸有特殊关柜规则时，运营在班次上单独填一个数即可，不必每班手工填死一个时间点。
--
-- 纯加可空列：不改数据、不改约束、无默认值（NULL 语义 = 跟随系统默认），回滚只需 DROP COLUMN。

-- AlterTable
ALTER TABLE "FlightSchedule" ADD COLUMN IF NOT EXISTS "checkinCloseMinutes" INTEGER;
