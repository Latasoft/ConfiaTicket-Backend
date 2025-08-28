-- AlterTable
ALTER TABLE `reservation` ADD COLUMN `refundId` VARCHAR(100) NULL,
    ADD COLUMN `refundReason` VARCHAR(255) NULL,
    ADD COLUMN `refundStatus` ENUM('NONE', 'REQUESTED', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'NONE',
    ADD COLUMN `refundedAt` DATETIME(3) NULL,
    ADD COLUMN `ticketUploadDeadlineAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `Reservation_status_ticketUploadDeadlineAt_idx` ON `Reservation`(`status`, `ticketUploadDeadlineAt`);

-- CreateIndex
CREATE INDEX `Reservation_refundStatus_idx` ON `Reservation`(`refundStatus`);
