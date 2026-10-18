-- 画布列表置顶（NULL = 未置顶）
ALTER TABLE `CanvasSession` ADD COLUMN `pinnedAt` DATETIME(3) NULL;
