-- 会话后台任务（见 background 模块）
CREATE TABLE `BackgroundTask` (
    `id` VARCHAR(191) NOT NULL,
    `conversationId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `spec` JSON NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'running',
    `result` JSON NULL,
    `notify` BOOLEAN NOT NULL DEFAULT true,
    `delivered` BOOLEAN NOT NULL DEFAULT false,
    `polls` INTEGER NOT NULL DEFAULT 0,
    `deadlineAt` DATETIME(3) NOT NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `BackgroundTask_conversationId_status_idx`(`conversationId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
