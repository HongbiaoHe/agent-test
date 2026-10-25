-- 附件理解：每个媒体版本至多一份分析结果（发送时自动分析，见 media-analysis 模块）
CREATE TABLE `MediaAnalysis` (
    `id` VARCHAR(191) NOT NULL,
    `versionId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `summary` TEXT NULL,
    `detail` JSON NULL,
    `model` VARCHAR(191) NULL,
    `error` TEXT NULL,
    `inputTokens` INTEGER NOT NULL DEFAULT 0,
    `outputTokens` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MediaAnalysis_versionId_key`(`versionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `MediaAnalysis` ADD CONSTRAINT `MediaAnalysis_versionId_fkey` FOREIGN KEY (`versionId`) REFERENCES `MediaVersion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
