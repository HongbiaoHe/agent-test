/*
  Warnings:

  - You are about to drop the column `data` on the `CanvasNode` table. All the data in the column will be lost.
  - You are about to drop the column `canvasVersion` on the `CanvasSession` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE `CanvasMessage` ADD COLUMN `runId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `CanvasNode` DROP COLUMN `data`,
    ADD COLUMN `assetPath` VARCHAR(191) NULL,
    ADD COLUMN `label` VARCHAR(191) NULL,
    ADD COLUMN `mediaGenerationId` VARCHAR(191) NULL,
    ADD COLUMN `prompt` TEXT NULL,
    ADD COLUMN `text` TEXT NULL;

-- AlterTable
ALTER TABLE `CanvasSession` DROP COLUMN `canvasVersion`,
    ADD COLUMN `revision` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `CanvasRun` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'queued',
    `trigger` JSON NOT NULL,
    `model` VARCHAR(191) NULL,
    `error` TEXT NULL,
    `promptTokens` INTEGER NOT NULL DEFAULT 0,
    `completionTokens` INTEGER NOT NULL DEFAULT 0,
    `totalTokens` INTEGER NOT NULL DEFAULT 0,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `endedAt` DATETIME(3) NULL,

    INDEX `CanvasRun_sessionId_idx`(`sessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CanvasTokenUsage` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `model` VARCHAR(191) NOT NULL,
    `inputTokens` INTEGER NOT NULL,
    `outputTokens` INTEGER NOT NULL,
    `totalTokens` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CanvasTokenUsage_sessionId_idx`(`sessionId`),
    INDEX `CanvasTokenUsage_runId_idx`(`runId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CanvasOp` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `seq` INTEGER NOT NULL,
    `actor` VARCHAR(191) NOT NULL,
    `op` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `CanvasOp_sessionId_seq_key`(`sessionId`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CanvasRun` ADD CONSTRAINT `CanvasRun_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `CanvasSession`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CanvasOp` ADD CONSTRAINT `CanvasOp_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `CanvasSession`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
