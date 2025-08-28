/*
  Warnings:

  - You are about to alter the column `title` on the `event` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `VarChar(120)`.
  - You are about to alter the column `location` on the `event` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `VarChar(120)`.
  - You are about to alter the column `payoutAccountNumber` on the `event` table. The data in that column could be lost. The data in that column will be cast from `VarChar(64)` to `VarChar(30)`.
  - You are about to alter the column `payoutAccountType` on the `event` table. The data in that column could be lost. The data in that column will be cast from `VarChar(32)` to `VarChar(16)`.
  - You are about to alter the column `payoutBankName` on the `event` table. The data in that column could be lost. The data in that column will be cast from `VarChar(128)` to `VarChar(80)`.
  - You are about to alter the column `payoutHolderName` on the `event` table. The data in that column could be lost. The data in that column will be cast from `VarChar(255)` to `VarChar(100)`.
  - You are about to alter the column `legalName` on the `organizerapplication` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `VarChar(150)`.
  - You are about to alter the column `taxId` on the `organizerapplication` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `VarChar(32)`.
  - You are about to alter the column `phone` on the `organizerapplication` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `VarChar(30)`.
  - You are about to alter the column `name` on the `user` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `VarChar(100)`.
  - You are about to alter the column `password` on the `user` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `VarChar(100)`.
  - You are about to alter the column `role` on the `user` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `VarChar(16)`.
*/

-- =====================================================================
-- PRE-SANITIZACIÓN DE DATOS (evita "Data too long for column ...")
-- =====================================================================

-- EVENT
UPDATE `event`
SET `title` = LEFT(`title`, 120)
WHERE CHAR_LENGTH(`title`) > 120;

UPDATE `event`
SET `location` = LEFT(`location`, 120)
WHERE CHAR_LENGTH(`location`) > 120;

UPDATE `event`
SET `payoutAccountNumber` = LEFT(
  REPLACE(REPLACE(REPLACE(REPLACE(`payoutAccountNumber`, ' ', ''), '-', ''), '.', ''), ',',''),
  30
)
WHERE `payoutAccountNumber` IS NOT NULL AND CHAR_LENGTH(`payoutAccountNumber`) > 30;

UPDATE `event`
SET `payoutAccountType` = LEFT(`payoutAccountType`, 16)
WHERE `payoutAccountType` IS NOT NULL AND CHAR_LENGTH(`payoutAccountType`) > 16;

UPDATE `event`
SET `payoutBankName` = LEFT(`payoutBankName`, 80)
WHERE `payoutBankName` IS NOT NULL AND CHAR_LENGTH(`payoutBankName`) > 80;

UPDATE `event`
SET `payoutHolderName` = LEFT(`payoutHolderName`, 100)
WHERE `payoutHolderName` IS NOT NULL AND CHAR_LENGTH(`payoutHolderName`) > 100;

-- ORGANIZERAPPLICATION
UPDATE `organizerapplication`
SET `legalName` = LEFT(`legalName`, 150)
WHERE CHAR_LENGTH(`legalName`) > 150;

UPDATE `organizerapplication`
SET `taxId` = LEFT(
  REPLACE(REPLACE(REPLACE(REPLACE(`taxId`, ' ', ''), '-', ''), '.', ''), ',',''),
  32
)
WHERE CHAR_LENGTH(`taxId`) > 32;

UPDATE `organizerapplication`
SET `phone` = LEFT(
  REPLACE(REPLACE(REPLACE(REPLACE(`phone`, ' ', ''), '-', ''), '(', ''), ')', ''),
  30
)
WHERE `phone` IS NOT NULL AND CHAR_LENGTH(`phone`) > 30;

-- USER
UPDATE `user`
SET `name` = LEFT(`name`, 100)
WHERE CHAR_LENGTH(`name`) > 100;

UPDATE `user`
SET `password` = LEFT(`password`, 100)
WHERE CHAR_LENGTH(`password`) > 100;

UPDATE `user`
SET `role` = LEFT(`role`, 16)
WHERE CHAR_LENGTH(`role`) > 16;

-- =====================================================================
-- CAMBIOS DE ESQUEMA
-- =====================================================================

-- Event: acotar longitud y ajustar tipos
ALTER TABLE `event`
  MODIFY `title` VARCHAR(120) NOT NULL,
  MODIFY `description` VARCHAR(4000) NOT NULL,
  MODIFY `location` VARCHAR(120) NOT NULL,
  MODIFY `payoutAccountNumber` VARCHAR(30) NULL,
  MODIFY `payoutAccountType` VARCHAR(16) NULL,
  MODIFY `payoutBankName` VARCHAR(80) NULL,
  MODIFY `payoutHolderName` VARCHAR(100) NULL;

-- OrganizerApplication: acotar/expandir columnas
ALTER TABLE `organizerapplication`
  MODIFY `legalName` VARCHAR(150) NOT NULL,
  MODIFY `taxId` VARCHAR(32) NOT NULL,
  MODIFY `phone` VARCHAR(30) NULL,
  MODIFY `notes` TEXT NULL,
  MODIFY `idCardImage` VARCHAR(1024) NOT NULL;

-- User: acotar y normalizar longitudes
ALTER TABLE `user`
  MODIFY `name` VARCHAR(100) NOT NULL,
  MODIFY `email` VARCHAR(254) NOT NULL,
  MODIFY `password` VARCHAR(100) NOT NULL,
  MODIFY `role` VARCHAR(16) NOT NULL,
  MODIFY `documentUrl` VARCHAR(1024) NULL;

