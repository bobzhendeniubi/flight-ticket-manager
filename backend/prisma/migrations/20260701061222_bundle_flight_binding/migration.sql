-- AlterTable: 套餐绑定去程 / 回程航班号（模板绑法：只绑航班号，不绑某天；买家选出发日后解析具体班次）
ALTER TABLE "Bundle" ADD COLUMN "outboundFlightId" TEXT;
ALTER TABLE "Bundle" ADD COLUMN "returnFlightId" TEXT;

-- AddForeignKey: 删航班不删套餐，只解除绑定（onDelete SetNull）
ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_outboundFlightId_fkey" FOREIGN KEY ("outboundFlightId") REFERENCES "Flight"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_returnFlightId_fkey" FOREIGN KEY ("returnFlightId") REFERENCES "Flight"("id") ON DELETE SET NULL ON UPDATE CASCADE;
