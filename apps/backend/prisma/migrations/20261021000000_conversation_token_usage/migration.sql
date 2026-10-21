-- Spark 对话 agent 的 token 用量明细（每次模型调用一行；按触发的用户消息分轮）
CREATE TABLE `ConversationTokenUsage` (
    `id` VARCHAR(191) NOT NULL,
    `conversationId` VARCHAR(191) NOT NULL,
    `turnMessageId` VARCHAR(191) NOT NULL,
    `messageId` VARCHAR(191) NULL,
    `model` VARCHAR(191) NOT NULL,
    `inputTokens` INTEGER NOT NULL,
    `outputTokens` INTEGER NOT NULL,
    `totalTokens` INTEGER NOT NULL,
    `cacheReadTokens` INTEGER NOT NULL DEFAULT 0,
    `cacheCreationTokens` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ConversationTokenUsage_conversationId_idx`(`conversationId`),
    UNIQUE INDEX `ConversationTokenUsage_conversationId_messageId_key`(`conversationId`, `messageId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
