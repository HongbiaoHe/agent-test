-- AlterTable
ALTER TABLE `User` ADD COLUMN `sandboxSize` VARCHAR(16) NULL;

-- CreateTable
CREATE TABLE `SandboxMigration` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(16) NOT NULL,
    `fromSize` VARCHAR(16) NOT NULL,
    `toSize` VARCHAR(16) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'running',
    `phase` VARCHAR(16) NOT NULL DEFAULT 'prepare',
    `message` TEXT NULL,
    `oldSandboxId` VARCHAR(128) NULL,
    `newSandboxId` VARCHAR(128) NULL,
    `fileCount` INTEGER NULL,
    `totalBytes` BIGINT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `finishedAt` DATETIME(3) NULL,

    INDEX `SandboxMigration_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
