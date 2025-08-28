-- AlterTable
ALTER TABLE `reservation` ADD COLUMN `approvedAt` DATETIME(3) NULL,
    ADD COLUMN `approvedByAdminId` INTEGER NULL,
    ADD COLUMN `deliveredAt` DATETIME(3) NULL,
    ADD COLUMN `fulfillmentStatus` ENUM('WAITING_TICKET', 'TICKET_UPLOADED', 'TICKET_APPROVED', 'TICKET_REJECTED', 'DELIVERED') NOT NULL DEFAULT 'WAITING_TICKET',
    ADD COLUMN `rejectionReason` VARCHAR(191) NULL,
    ADD COLUMN `ticketChecksum` VARCHAR(64) NULL,
    ADD COLUMN `ticketFileName` VARCHAR(255) NULL,
    ADD COLUMN `ticketFilePath` VARCHAR(1024) NULL,
    ADD COLUMN `ticketMime` VARCHAR(127) NULL,
    ADD COLUMN `ticketUploadedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `Reservation_fulfillmentStatus_idx` ON `Reservation`(`fulfillmentStatus`);

-- CreateIndex
CREATE INDEX `Reservation_approvedByAdminId_idx` ON `Reservation`(`approvedByAdminId`);

-- AddForeignKey
ALTER TABLE `Reservation` ADD CONSTRAINT `Reservation_approvedByAdminId_fkey` FOREIGN KEY (`approvedByAdminId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
