-- AlterTable
ALTER TABLE `connectedaccount` ADD COLUMN `payoutAccountNumber` VARCHAR(30) NULL,
    ADD COLUMN `payoutAccountType` ENUM('VISTA', 'CORRIENTE', 'AHORRO', 'RUT') NULL,
    ADD COLUMN `payoutBankName` VARCHAR(80) NULL,
    ADD COLUMN `payoutHolderName` VARCHAR(100) NULL,
    ADD COLUMN `payoutHolderRut` VARCHAR(16) NULL;
