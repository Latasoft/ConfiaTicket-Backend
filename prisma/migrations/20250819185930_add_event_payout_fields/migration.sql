-- AlterTable
ALTER TABLE `event` ADD COLUMN `payoutAccountNumber` VARCHAR(64) NULL,
    ADD COLUMN `payoutAccountType` VARCHAR(32) NULL,
    ADD COLUMN `payoutBankName` VARCHAR(128) NULL,
    ADD COLUMN `payoutHolderName` VARCHAR(255) NULL,
    ADD COLUMN `payoutHolderRut` VARCHAR(16) NULL;
