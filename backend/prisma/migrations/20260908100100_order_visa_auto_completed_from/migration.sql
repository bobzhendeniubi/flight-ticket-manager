-- 自动办结（全员已送签 → HAS_VISA）前的录单签证口径；签证台筛选读「本列 ?? visaStatus」
ALTER TABLE "Order" ADD COLUMN "visaAutoCompletedFrom" "VisaRequirement";
