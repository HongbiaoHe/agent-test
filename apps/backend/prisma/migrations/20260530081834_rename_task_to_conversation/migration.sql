/*
  Warnings:

  - You are about to drop the column `taskId` on the `Approval` table. All the data in the column will be lost.
  - You are about to drop the column `taskId` on the `Message` table. All the data in the column will be lost.
  - You are about to drop the `Task` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `conversationId` to the `Approval` table without a default value. This is not possible if the table is not empty.
  - Added the required column `conversationId` to the `Message` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE `Message` DROP FOREIGN KEY `Message_taskId_fkey`;

-- DropIndex
DROP INDEX `Approval_taskId_idx` ON `Approval`;

-- DropIndex
DROP INDEX `Message_taskId_seq_idx` ON `Message`;

-- AlterTable
ALTER TABLE `Approval` DROP COLUMN `taskId`,
    ADD COLUMN `conversationId` VARCHAR(191) NOT NULL;

-- AlterTable
ALTER TABLE `Message` DROP COLUMN `taskId`,
    ADD COLUMN `conversationId` VARCHAR(191) NOT NULL;

-- DropTable
DROP TABLE `Task`;

-- CreateTable
CREATE TABLE `Conversation` (
    `id` VARCHAR(191) NOT NULL,
    `goal` TEXT NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'queued',
    `tenantId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Conversation_tenantId_idx`(`tenantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Approval_conversationId_idx` ON `Approval`(`conversationId`);

-- CreateIndex
CREATE INDEX `Message_conversationId_seq_idx` ON `Message`(`conversationId`, `seq`);

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
