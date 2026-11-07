-- Agent 模式：用户自建的「完整系统提示 + 勾选的工具 / MCP server / 技能」（见 modes 模块）
CREATE TABLE `AgentMode` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `systemPrompt` TEXT NOT NULL,
    `toolNames` JSON NOT NULL,
    `mcpServerIds` JSON NOT NULL,
    `skillNames` JSON NOT NULL,
    `defaultModel` VARCHAR(191) NULL,
    `defaultThinkingLevel` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AgentMode_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 会话选用的模式；NULL = 通用模式。删模式时置空
ALTER TABLE `Conversation` ADD COLUMN `modeId` VARCHAR(191) NULL;
