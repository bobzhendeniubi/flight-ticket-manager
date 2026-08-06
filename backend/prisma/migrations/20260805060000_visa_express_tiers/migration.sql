-- 签证加急分档（零工 / 一工 / 二工 …）
--
-- 旧模型只有单值 expressSurcharge + 单值 processingDays，表达不了「不同加急等级出签天数不同、
-- 加价也不同」。新增 JSON 列存分档表：[{ label: "一工", workDays: 1, surchargeCny: 100 }, ...]，
-- 由运营在产品管理里自行增删档位。
--
-- 旧列 expressSurcharge 保留不动：未配分档的产品（expressTiers = []）仍按旧的单值口径计价与展示，
-- 历史订单金额不受影响。定价只认档内 surchargeCny（服务端按档名查表，客户端只传档名不传金额）。

-- AlterTable
ALTER TABLE "Visa" ADD COLUMN     "expressTiers" JSONB NOT NULL DEFAULT '[]';
