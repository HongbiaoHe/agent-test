-- 用户改写的平台片段正文：每个用户每个片段至多一行，没有行 = 用 core 默认（见 modes 模块）
CREATE TABLE `PromptFragmentOverride` (
    `userId` VARCHAR(191) NOT NULL,
    `fragmentId` VARCHAR(64) NOT NULL,
    `text` TEXT NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`userId`, `fragmentId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
