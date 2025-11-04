/*
  Warnings:

  - Added the required column `idCardImageBack` to the `OrganizerApplication` table without a default value. This is not possible if the table is not empty.
  - Added the required column `payoutAccountNumber` to the `OrganizerApplication` table without a default value. This is not possible if the table is not empty.
  - Added the required column `payoutAccountType` to the `OrganizerApplication` table without a default value. This is not possible if the table is not empty.
  - Added the required column `payoutBankName` to the `OrganizerApplication` table without a default value. This is not possible if the table is not empty.
  - Added the required column `payoutHolderName` to the `OrganizerApplication` table without a default value. This is not possible if the table is not empty.
  - Added the required column `payoutHolderRut` to the `OrganizerApplication` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "public"."EventType" AS ENUM ('OWN', 'RESALE');

-- CreateEnum
CREATE TYPE "public"."ClaimReason" AS ENUM ('TICKET_NOT_RECEIVED', 'TICKET_INVALID', 'TICKET_DUPLICATED', 'EVENT_CANCELLED', 'EVENT_CHANGED', 'WRONG_SEATS', 'POOR_QUALITY', 'OVERCHARGED', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."ClaimStatus" AS ENUM ('PENDING', 'IN_REVIEW', 'WAITING_INFO', 'RESOLVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."ClaimPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "public"."ClaimMessageType" AS ENUM ('BUYER_MESSAGE', 'BUYER_EVIDENCE', 'ADMIN_RESPONSE', 'SYSTEM_NOTE');

-- CreateEnum
CREATE TYPE "public"."ConfigCategory" AS ENUM ('TICKET_LIMIT', 'PRICE_LIMIT', 'FIELD_LIMIT', 'BUSINESS_RULE');

-- CreateEnum
CREATE TYPE "public"."ConfigDataType" AS ENUM ('INTEGER', 'DECIMAL', 'STRING', 'BOOLEAN');

-- DropIndex
DROP INDEX "public"."Event_city_idx";

-- DropIndex
DROP INDEX "public"."Event_commune_idx";

-- AlterTable
ALTER TABLE "public"."Event" ADD COLUMN     "eventType" "public"."EventType" NOT NULL DEFAULT 'OWN',
ADD COLUMN     "priceBase" INTEGER;

-- AlterTable
ALTER TABLE "public"."OrganizerApplication" ADD COLUMN     "idCardImageBack" VARCHAR(1024) NOT NULL,
ADD COLUMN     "payoutAccountNumber" VARCHAR(30) NOT NULL,
ADD COLUMN     "payoutAccountType" "public"."AccountType" NOT NULL,
ADD COLUMN     "payoutBankName" VARCHAR(80) NOT NULL,
ADD COLUMN     "payoutHolderName" VARCHAR(100) NOT NULL,
ADD COLUMN     "payoutHolderRut" VARCHAR(16) NOT NULL;

-- AlterTable
ALTER TABLE "public"."Reservation" ADD COLUMN     "generatedPdfPath" VARCHAR(1024),
ADD COLUMN     "purchaseGroupId" VARCHAR(36),
ADD COLUMN     "qrCode" VARCHAR(100),
ADD COLUMN     "scanned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scannedAt" TIMESTAMP(3),
ADD COLUMN     "seatAssignment" VARCHAR(500),
ADD COLUMN     "sectionId" INTEGER;

-- CreateTable
CREATE TABLE "public"."Ticket" (
    "id" SERIAL NOT NULL,
    "eventId" INTEGER NOT NULL,
    "ticketCode" VARCHAR(100) NOT NULL,
    "row" VARCHAR(20) NOT NULL,
    "seat" VARCHAR(20) NOT NULL,
    "zone" VARCHAR(50),
    "level" VARCHAR(50),
    "description" VARCHAR(200),
    "imageFilePath" VARCHAR(1024) NOT NULL,
    "imageFileName" VARCHAR(255) NOT NULL,
    "imageMime" VARCHAR(127) NOT NULL,
    "imageChecksum" VARCHAR(64),
    "originalQrCode" VARCHAR(500),
    "proxyQrCode" VARCHAR(100),
    "scannedCount" INTEGER NOT NULL DEFAULT 0,
    "lastScannedAt" TIMESTAMP(3),
    "scannedLogs" JSONB,
    "sold" BOOLEAN NOT NULL DEFAULT false,
    "soldAt" TIMESTAMP(3),
    "reservationId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EventSection" (
    "id" SERIAL NOT NULL,
    "eventId" INTEGER NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "rowStart" VARCHAR(20),
    "rowEnd" VARCHAR(20),
    "seatsPerRow" INTEGER,
    "seatStart" INTEGER,
    "seatEnd" INTEGER,
    "totalCapacity" INTEGER NOT NULL,
    "description" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GeneratedTicket" (
    "id" SERIAL NOT NULL,
    "reservationId" INTEGER NOT NULL,
    "ticketNumber" INTEGER NOT NULL,
    "seatNumber" VARCHAR(50),
    "qrCode" VARCHAR(100) NOT NULL,
    "pdfPath" VARCHAR(1024) NOT NULL,
    "scanned" BOOLEAN NOT NULL DEFAULT false,
    "scannedAt" TIMESTAMP(3),
    "scannedBy" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeneratedTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Claim" (
    "id" SERIAL NOT NULL,
    "buyerId" INTEGER NOT NULL,
    "reservationId" INTEGER NOT NULL,
    "eventId" INTEGER NOT NULL,
    "reason" "public"."ClaimReason" NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "status" "public"."ClaimStatus" NOT NULL DEFAULT 'PENDING',
    "priority" "public"."ClaimPriority" NOT NULL DEFAULT 'MEDIUM',
    "attachmentUrl" VARCHAR(1024),
    "adminResponse" VARCHAR(2000),
    "reviewedBy" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "resolution" VARCHAR(2000),
    "resolvedAt" TIMESTAMP(3),
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "reopenedAt" TIMESTAMP(3),
    "canReopen" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ClaimMessage" (
    "id" SERIAL NOT NULL,
    "claimId" INTEGER NOT NULL,
    "type" "public"."ClaimMessageType" NOT NULL,
    "message" VARCHAR(2000),
    "attachments" JSONB,
    "authorId" INTEGER,
    "authorRole" VARCHAR(20),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SystemConfig" (
    "id" SERIAL NOT NULL,
    "category" "public"."ConfigCategory" NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "value" VARCHAR(500) NOT NULL,
    "dataType" "public"."ConfigDataType" NOT NULL,
    "description" VARCHAR(500),
    "isEditable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TicketLimitConfig" (
    "id" SERIAL NOT NULL,
    "eventType" VARCHAR(20) NOT NULL,
    "minCapacity" INTEGER NOT NULL,
    "maxCapacity" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketLimitConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PriceLimitConfig" (
    "id" SERIAL NOT NULL,
    "minPrice" INTEGER NOT NULL,
    "maxPrice" INTEGER NOT NULL,
    "resaleMarkupPercent" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceLimitConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PlatformFeeConfig" (
    "id" SERIAL NOT NULL,
    "feeBps" INTEGER NOT NULL DEFAULT 0,
    "description" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformFeeConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FieldLimitConfig" (
    "id" SERIAL NOT NULL,
    "fieldName" VARCHAR(100) NOT NULL,
    "maxLength" INTEGER NOT NULL,
    "context" VARCHAR(100),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FieldLimitConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_proxyQrCode_key" ON "public"."Ticket"("proxyQrCode");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_reservationId_key" ON "public"."Ticket"("reservationId");

-- CreateIndex
CREATE INDEX "Ticket_eventId_sold_idx" ON "public"."Ticket"("eventId", "sold");

-- CreateIndex
CREATE INDEX "Ticket_proxyQrCode_idx" ON "public"."Ticket"("proxyQrCode");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_eventId_row_seat_zone_key" ON "public"."Ticket"("eventId", "row", "seat", "zone");

-- CreateIndex
CREATE INDEX "EventSection_eventId_idx" ON "public"."EventSection"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedTicket_qrCode_key" ON "public"."GeneratedTicket"("qrCode");

-- CreateIndex
CREATE INDEX "GeneratedTicket_reservationId_idx" ON "public"."GeneratedTicket"("reservationId");

-- CreateIndex
CREATE INDEX "GeneratedTicket_qrCode_idx" ON "public"."GeneratedTicket"("qrCode");

-- CreateIndex
CREATE INDEX "GeneratedTicket_scanned_idx" ON "public"."GeneratedTicket"("scanned");

-- CreateIndex
CREATE INDEX "Claim_buyerId_idx" ON "public"."Claim"("buyerId");

-- CreateIndex
CREATE INDEX "Claim_reservationId_idx" ON "public"."Claim"("reservationId");

-- CreateIndex
CREATE INDEX "Claim_eventId_idx" ON "public"."Claim"("eventId");

-- CreateIndex
CREATE INDEX "Claim_status_idx" ON "public"."Claim"("status");

-- CreateIndex
CREATE INDEX "Claim_priority_idx" ON "public"."Claim"("priority");

-- CreateIndex
CREATE INDEX "Claim_createdAt_idx" ON "public"."Claim"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_reservationId_key" ON "public"."Claim"("reservationId");

-- CreateIndex
CREATE INDEX "ClaimMessage_claimId_idx" ON "public"."ClaimMessage"("claimId");

-- CreateIndex
CREATE INDEX "ClaimMessage_createdAt_idx" ON "public"."ClaimMessage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SystemConfig_key_key" ON "public"."SystemConfig"("key");

-- CreateIndex
CREATE INDEX "SystemConfig_category_idx" ON "public"."SystemConfig"("category");

-- CreateIndex
CREATE INDEX "SystemConfig_key_idx" ON "public"."SystemConfig"("key");

-- CreateIndex
CREATE UNIQUE INDEX "TicketLimitConfig_eventType_key" ON "public"."TicketLimitConfig"("eventType");

-- CreateIndex
CREATE INDEX "TicketLimitConfig_eventType_idx" ON "public"."TicketLimitConfig"("eventType");

-- CreateIndex
CREATE UNIQUE INDEX "FieldLimitConfig_fieldName_key" ON "public"."FieldLimitConfig"("fieldName");

-- CreateIndex
CREATE INDEX "FieldLimitConfig_fieldName_idx" ON "public"."FieldLimitConfig"("fieldName");

-- CreateIndex
CREATE INDEX "FieldLimitConfig_context_idx" ON "public"."FieldLimitConfig"("context");

-- CreateIndex
CREATE INDEX "Event_eventType_idx" ON "public"."Event"("eventType");

-- CreateIndex
CREATE INDEX "Reservation_qrCode_idx" ON "public"."Reservation"("qrCode");

-- CreateIndex
CREATE INDEX "Reservation_scanned_idx" ON "public"."Reservation"("scanned");

-- CreateIndex
CREATE INDEX "Reservation_purchaseGroupId_idx" ON "public"."Reservation"("purchaseGroupId");

-- CreateIndex
CREATE INDEX "Reservation_sectionId_idx" ON "public"."Reservation"("sectionId");

-- AddForeignKey
ALTER TABLE "public"."Ticket" ADD CONSTRAINT "Ticket_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Ticket" ADD CONSTRAINT "Ticket_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "public"."Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventSection" ADD CONSTRAINT "EventSection_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GeneratedTicket" ADD CONSTRAINT "GeneratedTicket_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "public"."Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Claim" ADD CONSTRAINT "Claim_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Claim" ADD CONSTRAINT "Claim_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "public"."Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Claim" ADD CONSTRAINT "Claim_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ClaimMessage" ADD CONSTRAINT "ClaimMessage_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "public"."Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
