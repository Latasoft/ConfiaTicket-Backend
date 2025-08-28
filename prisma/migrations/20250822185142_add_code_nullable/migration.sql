/*
  Warnings:

  - A unique constraint covering the columns `[code]` on the table `Reservation` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `event` ADD COLUMN `price` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `reservation` ADD COLUMN `amount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `code` VARCHAR(36) NULL,
    ADD COLUMN `expiresAt` DATETIME(3) NULL,
    ADD COLUMN `paidAt` DATETIME(3) NULL,
    ADD COLUMN `status` ENUM('PENDING_PAYMENT', 'PAID', 'CANCELED', 'EXPIRED') NOT NULL DEFAULT 'PENDING_PAYMENT',
    ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX `Reservation_code_key` ON `Reservation`(`code`);

-- CreateIndex
CREATE INDEX `Reservation_eventId_status_expiresAt_idx` ON `Reservation`(`eventId`, `status`, `expiresAt`);
