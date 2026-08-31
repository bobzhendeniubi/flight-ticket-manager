-- Bundle.selfVisaDeductCny: 0-默认改为可空（null = 跟随签证组件产品价）。
-- 存量行保持原显式值（含 0），行为不变；仅新建套餐缺省进入「跟随」语义。
ALTER TABLE "Bundle" ALTER COLUMN "selfVisaDeductCny" DROP NOT NULL;
ALTER TABLE "Bundle" ALTER COLUMN "selfVisaDeductCny" DROP DEFAULT;
