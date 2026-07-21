-- 代理名单格式绑定 + 识别词条（批量创单防呆）
-- rosterFormat：NULL = 未登记；取值三选一（应用层校验）：
--   COLON_MULTILINE_YMD（冒号多行·年-月-日）/ INLINE_NUMBERED（编号单行空格式）/ COLON_MULTILINE_DMY（冒号多行·日-月-年）
-- rosterKeywords：识别词条数组，默认空；全局查重在应用层（保存时校验，一词只归一家）。
ALTER TABLE "Agent" ADD COLUMN "rosterFormat" TEXT;
ALTER TABLE "Agent" ADD COLUMN "rosterKeywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
