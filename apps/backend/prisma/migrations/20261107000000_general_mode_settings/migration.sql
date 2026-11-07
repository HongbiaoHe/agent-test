-- 通用模式的用户覆盖：自定义提示词（NULL = 用 core 默认）+ 新建会话回填的默认模型 / 思考档位（见 modes 模块）
CREATE TABLE `GeneralModeSetting` (
    `userId` VARCHAR(191) NOT NULL,
    `systemPrompt` TEXT NULL,
    `defaultModel` VARCHAR(191) NULL,
    `defaultThinkingLevel` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
