/*
  Warnings:

  - A unique constraint covering the columns `[rut]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `user` ADD COLUMN `rut` VARCHAR(16) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `User_rut_key` ON `User`(`rut`);
