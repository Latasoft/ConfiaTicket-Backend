-- AlterTable
ALTER TABLE `payment` ADD COLUMN `applicationFeeAmount` INTEGER NULL,
    ADD COLUMN `authorizationExpiresAt` DATETIME(3) NULL,
    ADD COLUMN `authorizedAmount` INTEGER NULL,
    ADD COLUMN `captureId` VARCHAR(100) NULL,
    ADD COLUMN `capturedAmount` INTEGER NULL,
    ADD COLUMN `capturedAt` DATETIME(3) NULL,
    ADD COLUMN `currency` VARCHAR(191) NOT NULL DEFAULT 'CLP',
    ADD COLUMN `destinationAccountId` INTEGER NULL,
    ADD COLUMN `isDeferredCapture` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `netAmount` INTEGER NULL,
    ADD COLUMN `voidedAt` DATETIME(3) NULL,
    MODIFY `status` ENUM('INITIATED', 'AUTHORIZED', 'CAPTURED', 'COMMITTED', 'VOIDED', 'FAILED', 'ABORTED', 'TIMEOUT', 'REFUNDED') NOT NULL DEFAULT 'INITIATED';

-- CreateTable
CREATE TABLE `ConnectedAccount` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `psp` VARCHAR(32) NOT NULL,
    `pspAccountId` VARCHAR(128) NOT NULL,
    `onboardingStatus` ENUM('PENDING', 'REQUIRED', 'COMPLETE', 'RESTRICTED') NOT NULL DEFAULT 'PENDING',
    `payoutsEnabled` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ConnectedAccount_userId_key`(`userId`),
    UNIQUE INDEX `ConnectedAccount_pspAccountId_key`(`pspAccountId`),
    INDEX `ConnectedAccount_psp_pspAccountId_idx`(`psp`, `pspAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Payout` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `accountId` INTEGER NOT NULL,
    `paymentId` INTEGER NULL,
    `reservationId` INTEGER NULL,
    `amount` INTEGER NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'CLP',
    `status` ENUM('PENDING', 'SCHEDULED', 'IN_TRANSIT', 'PAID', 'FAILED', 'CANCELED') NOT NULL DEFAULT 'PENDING',
    `pspPayoutId` VARCHAR(128) NULL,
    `scheduledFor` DATETIME(3) NULL,
    `paidAt` DATETIME(3) NULL,
    `failureCode` VARCHAR(50) NULL,
    `failureMessage` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Payout_pspPayoutId_key`(`pspPayoutId`),
    INDEX `Payout_accountId_idx`(`accountId`),
    INDEX `Payout_status_idx`(`status`),
    INDEX `Payout_paymentId_idx`(`paymentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Payment_destinationAccountId_idx` ON `Payment`(`destinationAccountId`);

-- AddForeignKey
ALTER TABLE `ConnectedAccount` ADD CONSTRAINT `ConnectedAccount_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Payout` ADD CONSTRAINT `Payout_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `ConnectedAccount`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Payout` ADD CONSTRAINT `Payout_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `Payment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Payout` ADD CONSTRAINT `Payout_reservationId_fkey` FOREIGN KEY (`reservationId`) REFERENCES `Reservation`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_destinationAccountId_fkey` FOREIGN KEY (`destinationAccountId`) REFERENCES `ConnectedAccount`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
