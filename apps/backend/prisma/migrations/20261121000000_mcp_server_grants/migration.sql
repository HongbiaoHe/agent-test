-- 画布 MCP 对外服务：DCR 客户端 / 授权 / 令牌哈希（见 docs/superpowers/specs/2026-11-21-canvas-mcp-server-design.md）
CREATE TABLE `McpOAuthClient` (
    `id` VARCHAR(64) NOT NULL,
    `secretEnc` TEXT NULL,
    `metadata` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `McpGrant` (
    `id` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tenantId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `clientId` VARCHAR(64) NULL,
    `scopes` JSON NOT NULL,
    `lastUsedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `McpGrant_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `McpToken` (
    `id` VARCHAR(191) NOT NULL,
    `grantId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `hash` VARCHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `McpToken_hash_key`(`hash`),
    INDEX `McpToken_grantId_idx`(`grantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `McpToken` ADD CONSTRAINT `McpToken_grantId_fkey` FOREIGN KEY (`grantId`) REFERENCES `McpGrant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
