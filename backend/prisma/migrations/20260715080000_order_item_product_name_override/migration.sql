-- 录单自定义产品名称（订单行级快照，仅后台展示用；NULL = 未自定义，前端自动拼装）。
-- 与 description 分离：description 会被换酒店/补房差等流程自动重写，此字段一经写入不再变动。

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN "productNameOverride" TEXT;
