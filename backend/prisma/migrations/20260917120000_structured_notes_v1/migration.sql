-- 备注结构化（2026-09-17）：把高频写在自由备注里、下游要靠人眼看的四项做成字段。
--
-- 背景：实测 14 天 2470 单里 2455 单写了自由备注。「大床/双床」「单独编码」「和某某同一个酒店」
-- 「满五次兑换商务舱」这几类信息分房、房控、票务都要用，却只能一行行读备注文本。
--   · Passenger.upgradeRedeemLeg / upgradeRedeemNote —— 兑换升舱（哪一程 + 用谁的次数）
--   · Order.separatePnr                            —— 单独编码出票（不与他单合并 PNR）
--   · Order.sameHotelWith                          —— 同酒店安排（自由文本：写人名或单号）
-- 床型走早就存在的 Passenger.bedPref，本次只在界面露出，不加列。
--
-- 纯增列，全部带默认值 / 可空：存量一个字都不用回填，旧客户端不传也与改造前行为完全一致。
-- 存量备注的回填另有脚本（先 dry-run 给运营看），不在本迁移内。

-- CreateEnum
CREATE TYPE "UpgradeRedeemLeg" AS ENUM ('NONE', 'OUTBOUND', 'RETURN', 'BOTH');

-- AlterTable
ALTER TABLE "Passenger" ADD COLUMN "upgradeRedeemLeg" "UpgradeRedeemLeg" NOT NULL DEFAULT 'NONE',
ADD COLUMN "upgradeRedeemNote" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "separatePnr" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "sameHotelWith" TEXT;
