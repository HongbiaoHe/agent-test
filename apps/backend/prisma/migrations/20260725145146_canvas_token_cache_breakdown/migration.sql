-- AlterTable
ALTER TABLE `CanvasRun` ADD COLUMN `cacheCreationTokens` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `cacheReadTokens` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `CanvasTokenUsage` ADD COLUMN `cacheCreationTokens` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `cacheReadTokens` INTEGER NOT NULL DEFAULT 0;
