/*
  Warnings:

  - Made the column `code` on table `reservation` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE `reservation` MODIFY `code` VARCHAR(36) NOT NULL;
