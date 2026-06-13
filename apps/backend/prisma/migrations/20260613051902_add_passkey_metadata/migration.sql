-- AlterTable
ALTER TABLE `Authenticator` ADD COLUMN `aaguid` VARCHAR(191) NULL,
    ADD COLUMN `backedUp` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `deviceType` VARCHAR(191) NULL,
    ADD COLUMN `lastUsedAt` DATETIME(3) NULL;
