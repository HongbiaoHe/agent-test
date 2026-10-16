-- 会话级思考深度档位；NULL = auto（跟随模型默认）。映射见 src/agent/thinking-level.ts
ALTER TABLE `Conversation` ADD COLUMN `thinkingLevel` VARCHAR(191) NULL;
