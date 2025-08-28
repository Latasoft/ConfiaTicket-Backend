-- CreateTable
CREATE TABLE `Payment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `reservationId` INTEGER NOT NULL,
    `token` VARCHAR(128) NULL,
    `buyOrder` VARCHAR(100) NOT NULL,
    `sessionId` VARCHAR(100) NOT NULL,
    `amount` INTEGER NOT NULL,
    `status` ENUM('INITIATED', 'COMMITTED', 'FAILED', 'ABORTED', 'TIMEOUT', 'REFUNDED') NOT NULL DEFAULT 'INITIATED',
    `authorizationCode` VARCHAR(20) NULL,
    `paymentTypeCode` VARCHAR(10) NULL,
    `installmentsNumber` INTEGER NULL,
    `responseCode` INTEGER NULL,
    `accountingDate` VARCHAR(8) NULL,
    `transactionDate` DATETIME(3) NULL,
    `cardLast4` VARCHAR(4) NULL,
    `vci` VARCHAR(32) NULL,
    `commerceCode` VARCHAR(20) NULL,
    `environment` VARCHAR(16) NULL,
    `refundedAmount` INTEGER NULL,
    `lastRefundAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Payment_reservationId_key`(`reservationId`),
    UNIQUE INDEX `Payment_token_key`(`token`),
    UNIQUE INDEX `Payment_buyOrder_key`(`buyOrder`),
    INDEX `Payment_status_idx`(`status`),
    INDEX `Payment_token_idx`(`token`),
    INDEX `Payment_buyOrder_idx`(`buyOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_reservationId_fkey` FOREIGN KEY (`reservationId`) REFERENCES `Reservation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
