-- AlterTable
ALTER TABLE `payment` ADD COLUMN `capturePolicy` ENUM('IMMEDIATE', 'MANUAL_ON_APPROVAL') NOT NULL DEFAULT 'IMMEDIATE',
    ADD COLUMN `escrowExpiresAt` DATETIME(3) NULL,
    ADD COLUMN `escrowHoldId` VARCHAR(128) NULL,
    ADD COLUMN `escrowReleaseId` VARCHAR(128) NULL,
    ADD COLUMN `escrowReleasedAt` DATETIME(3) NULL,
    ADD COLUMN `escrowStatus` ENUM('NONE', 'HELD', 'RELEASED', 'RELEASE_FAILED', 'EXPIRED') NOT NULL DEFAULT 'NONE',
    ADD COLUMN `isSplit` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `psp` VARCHAR(32) NULL,
    ADD COLUMN `pspChargeId` VARCHAR(128) NULL,
    ADD COLUMN `pspMetadata` JSON NULL,
    ADD COLUMN `pspPaymentId` VARCHAR(128) NULL;

-- AlterTable
ALTER TABLE `payout` ADD COLUMN `source` ENUM('INTERNAL', 'PSP') NOT NULL DEFAULT 'INTERNAL';

-- CreateIndex
CREATE INDEX `Payment_psp_idx` ON `Payment`(`psp`);

-- CreateIndex
CREATE INDEX `Payment_pspPaymentId_idx` ON `Payment`(`pspPaymentId`);

-- CreateIndex
CREATE INDEX `Payment_escrowStatus_idx` ON `Payment`(`escrowStatus`);

-- CreateIndex
CREATE INDEX `Payment_capturePolicy_idx` ON `Payment`(`capturePolicy`);

-- CreateIndex
CREATE INDEX `Payout_source_idx` ON `Payout`(`source`);
