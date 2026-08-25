-- AlterTable
ALTER TABLE `CanvasTokenUsage` ADD COLUMN `messageId` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `CanvasTokenUsage_sessionId_messageId_key` ON `CanvasTokenUsage`(`sessionId`, `messageId`);
