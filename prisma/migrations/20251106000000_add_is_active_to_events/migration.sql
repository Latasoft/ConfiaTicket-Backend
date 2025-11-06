-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "Event_isActive_idx" ON "Event"("isActive");
