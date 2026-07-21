-- A20 岗位细分（2026-07-20 拍板）：STAFF 子角色。null=通用运营；专岗导出被强制裁到本岗模板。
CREATE TYPE "StaffRole" AS ENUM ('VISA_DESK', 'TICKETING', 'ROOM_CONTROL');
ALTER TABLE "User" ADD COLUMN "staffRole" "StaffRole";
