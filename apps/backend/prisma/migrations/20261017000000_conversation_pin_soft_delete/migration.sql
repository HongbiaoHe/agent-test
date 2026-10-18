-- 会话置顶（NULL = 未置顶）与软删除（NULL = 未删除）
ALTER TABLE `Conversation` ADD COLUMN `pinnedAt` DATETIME(3) NULL,
    ADD COLUMN `deletedAt` DATETIME(3) NULL;
