-- AlterTable
ALTER TABLE `user` ADD COLUMN `documentUrl` VARCHAR(191) NULL,
    ADD COLUMN `isVerified` BOOLEAN NOT NULL DEFAULT false;
