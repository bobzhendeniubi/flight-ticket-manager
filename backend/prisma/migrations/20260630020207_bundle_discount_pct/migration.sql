-- AlterTable: 套餐折扣百分比（替代旧的固定 CNY 让利 groundDiscount，新逻辑只读 discountPct）
ALTER TABLE "Bundle" ADD COLUMN "discountPct" INTEGER NOT NULL DEFAULT 0;
