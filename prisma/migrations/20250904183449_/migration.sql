/*
  Warnings:

  - A unique constraint covering the columns `[reservationId]` on the table `Payout` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX `Payout_reservationId_key` ON `Payout`(`reservationId`);
