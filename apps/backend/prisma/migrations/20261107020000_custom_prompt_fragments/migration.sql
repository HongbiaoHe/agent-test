-- 用户自建的提示词片段：{{custom.xxx}} 引用，按用户隔离；id 创建后不可改（见 modes 模块）
CREATE TABLE `CustomPromptFragment` (
    `userId` VARCHAR(191) NOT NULL,
    `fragmentId` VARCHAR(64) NOT NULL,
    `title` VARCHAR(100) NOT NULL,
    `text` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`userId`, `fragmentId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
