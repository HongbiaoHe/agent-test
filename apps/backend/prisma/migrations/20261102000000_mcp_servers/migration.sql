-- MCP 连接器：用户接入的远程 MCP server（见 mcp 模块）
CREATE TABLE `McpServer` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(32) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `url` VARCHAR(512) NOT NULL,
    `presetKey` VARCHAR(64) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `status` VARCHAR(32) NOT NULL DEFAULT 'disconnected',
    `lastError` TEXT NULL,
    `authType` VARCHAR(16) NOT NULL DEFAULT 'none',
    `oauthClient` TEXT NULL,
    `oauthTokens` TEXT NULL,
    `serverInfo` JSON NULL,
    `instructions` TEXT NULL,
    `tools` JSON NULL,
    `toolPermissions` JSON NULL,
    `toolsRefreshedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `McpServer_userId_idx`(`userId`),
    UNIQUE INDEX `McpServer_userId_slug_key`(`userId`, `slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- MCP App 经 ui/update-model-context 交给模型的上下文（每个 App 最新一份）
ALTER TABLE `Conversation` ADD COLUMN `mcpAppContext` JSON NULL;
