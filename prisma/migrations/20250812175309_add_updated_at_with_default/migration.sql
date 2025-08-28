-- AlterTable
ALTER TABLE `event` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- AlterTable
ALTER TABLE `user` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- CreateIndex
CREATE INDEX `Event_approved_idx` ON `Event`(`approved`);

-- CreateIndex
CREATE INDEX `Event_date_idx` ON `Event`(`date`);

-- CreateIndex
CREATE INDEX `User_role_isVerified_idx` ON `User`(`role`, `isVerified`);

-- RenameIndex
ALTER TABLE `event` RENAME INDEX `Event_organizerId_fkey` TO `Event_organizerId_idx`;

-- RenameIndex
ALTER TABLE `reservation` RENAME INDEX `Reservation_buyerId_fkey` TO `Reservation_buyerId_idx`;

-- RenameIndex
ALTER TABLE `reservation` RENAME INDEX `Reservation_eventId_fkey` TO `Reservation_eventId_idx`;
