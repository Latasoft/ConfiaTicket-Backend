-- AlterTable
ALTER TABLE `user` ADD COLUMN `failedLoginCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `lockUntil` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `User_lockUntil_idx` ON `User`(`lockUntil`);

-- CreateIndex
CREATE INDEX `User_failedLoginCount_idx` ON `User`(`failedLoginCount`);
