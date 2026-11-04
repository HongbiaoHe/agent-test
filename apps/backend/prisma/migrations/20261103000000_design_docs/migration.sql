-- 分图层设计模块（design）：设计稿 + agent 对话记录
-- CreateTable
CREATE TABLE `DesignDoc` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL DEFAULT '未命名设计',
    `tenantId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'idle',
    `model` VARCHAR(191) NULL,
    `imageModel` JSON NULL,
    `document` JSON NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `DesignDoc_tenantId_updatedAt_idx`(`tenantId`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DesignMessage` (
    `id` VARCHAR(191) NOT NULL,
    `docId` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NULL,
    `role` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `content` JSON NOT NULL,
    `seq` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DesignMessage_docId_seq_idx`(`docId`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DesignMessage` ADD CONSTRAINT `DesignMessage_docId_fkey` FOREIGN KEY (`docId`) REFERENCES `DesignDoc`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

