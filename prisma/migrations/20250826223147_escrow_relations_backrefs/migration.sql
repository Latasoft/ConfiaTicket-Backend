-- DropForeignKey
ALTER TABLE `payment` DROP FOREIGN KEY `Payment_reservationId_fkey`;

-- AlterTable
ALTER TABLE `payment` MODIFY `reservationId` INTEGER NULL;

-- CreateTable
CREATE TABLE `ResaleListing` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `eventId` INTEGER NOT NULL,
    `sellerId` INTEGER NOT NULL,
    `askPrice` INTEGER NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'CLP',
    `status` ENUM('ACTIVE', 'PAUSED', 'SOLD', 'CANCELED', 'EXPIRED') NOT NULL DEFAULT 'ACTIVE',
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ResaleListing_eventId_idx`(`eventId`),
    INDEX `ResaleListing_sellerId_idx`(`sellerId`),
    INDEX `ResaleListing_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ResaleOrder` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `listingId` INTEGER NOT NULL,
    `buyerId` INTEGER NOT NULL,
    `status` ENUM('AWAITING_PAYMENT', 'AWAITING_TICKET', 'UNDER_REVIEW', 'DELIVERED', 'AWAITING_CONFIRMATION', 'RELEASED', 'REFUND_REQUESTED', 'REFUNDED', 'CANCELED', 'EXPIRED') NOT NULL DEFAULT 'AWAITING_PAYMENT',
    `amount` INTEGER NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'CLP',
    `paymentId` INTEGER NULL,
    `deliveredAt` DATETIME(3) NULL,
    `releasedAt` DATETIME(3) NULL,
    `canceledAt` DATETIME(3) NULL,
    `expiresUploadAt` DATETIME(3) NULL,
    `buyerConfirmDeadline` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ResaleOrder_paymentId_key`(`paymentId`),
    INDEX `ResaleOrder_listingId_idx`(`listingId`),
    INDEX `ResaleOrder_buyerId_idx`(`buyerId`),
    INDEX `ResaleOrder_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TicketAsset` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `orderId` INTEGER NOT NULL,
    `uploaderId` INTEGER NOT NULL,
    `path` VARCHAR(191) NOT NULL,
    `sha256` VARCHAR(191) NOT NULL,
    `filename` VARCHAR(191) NOT NULL,
    `contentType` VARCHAR(191) NOT NULL,
    `size` INTEGER NOT NULL,
    `parsedCode` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'RECEIVED',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TicketAsset_orderId_idx`(`orderId`),
    INDEX `TicketAsset_uploaderId_idx`(`uploaderId`),
    UNIQUE INDEX `TicketAsset_sha256_key`(`sha256`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EscrowTimeline` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `orderId` INTEGER NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `message` VARCHAR(191) NOT NULL,
    `meta` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `EscrowTimeline_orderId_idx`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_reservationId_fkey` FOREIGN KEY (`reservationId`) REFERENCES `Reservation`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ResaleListing` ADD CONSTRAINT `ResaleListing_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `Event`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ResaleListing` ADD CONSTRAINT `ResaleListing_sellerId_fkey` FOREIGN KEY (`sellerId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ResaleOrder` ADD CONSTRAINT `ResaleOrder_listingId_fkey` FOREIGN KEY (`listingId`) REFERENCES `ResaleListing`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ResaleOrder` ADD CONSTRAINT `ResaleOrder_buyerId_fkey` FOREIGN KEY (`buyerId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ResaleOrder` ADD CONSTRAINT `ResaleOrder_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `Payment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TicketAsset` ADD CONSTRAINT `TicketAsset_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `ResaleOrder`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TicketAsset` ADD CONSTRAINT `TicketAsset_uploaderId_fkey` FOREIGN KEY (`uploaderId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EscrowTimeline` ADD CONSTRAINT `EscrowTimeline_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `ResaleOrder`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
