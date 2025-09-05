-- AlterTable
ALTER TABLE `event` ADD COLUMN `city` VARCHAR(120) NULL,
    ADD COLUMN `commune` VARCHAR(120) NULL;

-- CreateIndex
CREATE INDEX `Event_city_idx` ON `Event`(`city`);

-- CreateIndex
CREATE INDEX `Event_commune_idx` ON `Event`(`commune`);
