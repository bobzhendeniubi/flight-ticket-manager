-- 财务岗：IF NOT EXISTS 保证目标库被人工预加过枚举值时迁移仍可幂等通过（PG16 支持）
ALTER TYPE "StaffRole" ADD VALUE IF NOT EXISTS 'FINANCE';
