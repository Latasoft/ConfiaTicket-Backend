-- CreateEnum
CREATE TYPE "public"."ReservationStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "public"."FulfillmentStatus" AS ENUM ('WAITING_TICKET', 'TICKET_UPLOADED', 'TICKET_APPROVED', 'TICKET_REJECTED', 'DELIVERED');

-- CreateEnum
CREATE TYPE "public"."RefundStatus" AS ENUM ('NONE', 'REQUESTED', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."ApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."PaymentStatus" AS ENUM ('INITIATED', 'AUTHORIZED', 'CAPTURED', 'COMMITTED', 'VOIDED', 'FAILED', 'ABORTED', 'TIMEOUT', 'REFUNDED');

-- CreateEnum
CREATE TYPE "public"."ConnectedOnboardingStatus" AS ENUM ('PENDING', 'REQUIRED', 'COMPLETE', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "public"."AccountType" AS ENUM ('VISTA', 'CORRIENTE', 'AHORRO', 'RUT');

-- CreateEnum
CREATE TYPE "public"."CapturePolicy" AS ENUM ('IMMEDIATE', 'MANUAL_ON_APPROVAL');

-- CreateEnum
CREATE TYPE "public"."PaymentEscrowStatus" AS ENUM ('NONE', 'HELD', 'RELEASED', 'RELEASE_FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "public"."PayoutStatus" AS ENUM ('PENDING', 'SCHEDULED', 'IN_TRANSIT', 'PAID', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "public"."PayoutSource" AS ENUM ('INTERNAL', 'PSP');

-- CreateEnum
CREATE TYPE "public"."ResaleListingStatus" AS ENUM ('ACTIVE', 'PAUSED', 'SOLD', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "public"."ResaleOrderStatus" AS ENUM ('AWAITING_PAYMENT', 'AWAITING_TICKET', 'UNDER_REVIEW', 'DELIVERED', 'AWAITING_CONFIRMATION', 'RELEASED', 'REFUND_REQUESTED', 'REFUNDED', 'CANCELED', 'EXPIRED');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password" VARCHAR(100) NOT NULL,
    "role" VARCHAR(16) NOT NULL,
    "rut" VARCHAR(16),
    "birthDate" DATE,
    "canSell" BOOLEAN NOT NULL DEFAULT true,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "anonymizedAt" TIMESTAMP(3),
    "documentUrl" VARCHAR(1024),
    "resetPasswordToken" VARCHAR(255),
    "resetPasswordExpires" TIMESTAMP(3),
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Event" (
    "id" SERIAL NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" VARCHAR(4000) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "location" VARCHAR(120) NOT NULL,
    "city" VARCHAR(120),
    "commune" VARCHAR(120),
    "capacity" INTEGER NOT NULL,
    "price" INTEGER NOT NULL DEFAULT 0,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "coverImageUrl" VARCHAR(1024),
    "organizerId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payoutBankName" VARCHAR(80),
    "payoutAccountType" VARCHAR(16),
    "payoutAccountNumber" VARCHAR(30),
    "payoutHolderName" VARCHAR(100),
    "payoutHolderRut" VARCHAR(16),

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Reservation" (
    "id" SERIAL NOT NULL,
    "eventId" INTEGER NOT NULL,
    "buyerId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "public"."ReservationStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "code" VARCHAR(36) NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fulfillmentStatus" "public"."FulfillmentStatus" NOT NULL DEFAULT 'WAITING_TICKET',
    "ticketFilePath" VARCHAR(1024),
    "ticketFileName" VARCHAR(255),
    "ticketMime" VARCHAR(127),
    "ticketChecksum" VARCHAR(64),
    "ticketUploadedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "approvedByAdminId" INTEGER,
    "ticketUploadDeadlineAt" TIMESTAMP(3),
    "refundStatus" "public"."RefundStatus" NOT NULL DEFAULT 'NONE',
    "refundedAt" TIMESTAMP(3),
    "refundId" VARCHAR(100),
    "refundReason" VARCHAR(255),

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OrganizerApplication" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "legalName" VARCHAR(150) NOT NULL,
    "taxId" VARCHAR(32) NOT NULL,
    "phone" VARCHAR(30),
    "notes" TEXT,
    "idCardImage" VARCHAR(1024) NOT NULL,
    "status" "public"."ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizerApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ConnectedAccount" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "psp" VARCHAR(32) NOT NULL,
    "pspAccountId" VARCHAR(128) NOT NULL,
    "onboardingStatus" "public"."ConnectedOnboardingStatus" NOT NULL DEFAULT 'PENDING',
    "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "payoutBankName" VARCHAR(80),
    "payoutAccountType" "public"."AccountType",
    "payoutAccountNumber" VARCHAR(30),
    "payoutHolderName" VARCHAR(100),
    "payoutHolderRut" VARCHAR(16),

    CONSTRAINT "ConnectedAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Payout" (
    "id" SERIAL NOT NULL,
    "accountId" INTEGER NOT NULL,
    "paymentId" INTEGER,
    "reservationId" INTEGER,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CLP',
    "status" "public"."PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "pspPayoutId" VARCHAR(128),
    "idempotencyKey" VARCHAR(80) NOT NULL,
    "externalStatus" VARCHAR(64),
    "scheduledFor" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "retries" INTEGER NOT NULL DEFAULT 0,
    "failureCode" VARCHAR(50),
    "failureMessage" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "source" "public"."PayoutSource" NOT NULL DEFAULT 'INTERNAL',

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Payment" (
    "id" SERIAL NOT NULL,
    "reservationId" INTEGER,
    "token" VARCHAR(128),
    "buyOrder" VARCHAR(100) NOT NULL,
    "sessionId" VARCHAR(100) NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CLP',
    "status" "public"."PaymentStatus" NOT NULL DEFAULT 'INITIATED',
    "destinationAccountId" INTEGER,
    "applicationFeeAmount" INTEGER,
    "netAmount" INTEGER,
    "isSplit" BOOLEAN NOT NULL DEFAULT false,
    "psp" VARCHAR(32),
    "pspPaymentId" VARCHAR(128),
    "pspChargeId" VARCHAR(128),
    "pspMetadata" JSONB,
    "authorizationCode" VARCHAR(20),
    "paymentTypeCode" VARCHAR(10),
    "installmentsNumber" INTEGER,
    "responseCode" INTEGER,
    "accountingDate" VARCHAR(8),
    "transactionDate" TIMESTAMP(3),
    "cardLast4" VARCHAR(4),
    "vci" VARCHAR(32),
    "isDeferredCapture" BOOLEAN NOT NULL DEFAULT false,
    "authorizedAmount" INTEGER,
    "authorizationExpiresAt" TIMESTAMP(3),
    "capturedAmount" INTEGER,
    "capturedAt" TIMESTAMP(3),
    "captureId" VARCHAR(100),
    "capturePolicy" "public"."CapturePolicy" NOT NULL DEFAULT 'IMMEDIATE',
    "escrowStatus" "public"."PaymentEscrowStatus" NOT NULL DEFAULT 'NONE',
    "escrowHoldId" VARCHAR(128),
    "escrowExpiresAt" TIMESTAMP(3),
    "escrowReleasedAt" TIMESTAMP(3),
    "escrowReleaseId" VARCHAR(128),
    "voidedAt" TIMESTAMP(3),
    "commerceCode" VARCHAR(20),
    "environment" VARCHAR(16),
    "refundedAmount" INTEGER,
    "lastRefundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LedgerEntry" (
    "id" SERIAL NOT NULL,
    "accountId" INTEGER NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "direction" VARCHAR(8) NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CLP',
    "memo" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentId" INTEGER,
    "reservationId" INTEGER,
    "payoutId" INTEGER,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ResaleListing" (
    "id" SERIAL NOT NULL,
    "eventId" INTEGER NOT NULL,
    "sellerId" INTEGER NOT NULL,
    "askPrice" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CLP',
    "status" "public"."ResaleListingStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResaleListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ResaleOrder" (
    "id" SERIAL NOT NULL,
    "listingId" INTEGER NOT NULL,
    "buyerId" INTEGER NOT NULL,
    "status" "public"."ResaleOrderStatus" NOT NULL DEFAULT 'AWAITING_PAYMENT',
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CLP',
    "paymentId" INTEGER,
    "deliveredAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "expiresUploadAt" TIMESTAMP(3),
    "buyerConfirmDeadline" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResaleOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TicketAsset" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "uploaderId" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "parsedCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EscrowTimeline" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EscrowTimeline_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_rut_key" ON "public"."User"("rut");

-- CreateIndex
CREATE INDEX "User_role_isVerified_idx" ON "public"."User"("role", "isVerified");

-- CreateIndex
CREATE INDEX "User_isActive_idx" ON "public"."User"("isActive");

-- CreateIndex
CREATE INDEX "User_deletedAt_idx" ON "public"."User"("deletedAt");

-- CreateIndex
CREATE INDEX "User_lockUntil_idx" ON "public"."User"("lockUntil");

-- CreateIndex
CREATE INDEX "User_failedLoginCount_idx" ON "public"."User"("failedLoginCount");

-- CreateIndex
CREATE INDEX "Event_organizerId_idx" ON "public"."Event"("organizerId");

-- CreateIndex
CREATE INDEX "Event_approved_idx" ON "public"."Event"("approved");

-- CreateIndex
CREATE INDEX "Event_date_idx" ON "public"."Event"("date");

-- CreateIndex
CREATE INDEX "Event_city_idx" ON "public"."Event"("city");

-- CreateIndex
CREATE INDEX "Event_commune_idx" ON "public"."Event"("commune");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_code_key" ON "public"."Reservation"("code");

-- CreateIndex
CREATE INDEX "Reservation_eventId_idx" ON "public"."Reservation"("eventId");

-- CreateIndex
CREATE INDEX "Reservation_buyerId_idx" ON "public"."Reservation"("buyerId");

-- CreateIndex
CREATE INDEX "Reservation_eventId_status_expiresAt_idx" ON "public"."Reservation"("eventId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "Reservation_fulfillmentStatus_idx" ON "public"."Reservation"("fulfillmentStatus");

-- CreateIndex
CREATE INDEX "Reservation_approvedByAdminId_idx" ON "public"."Reservation"("approvedByAdminId");

-- CreateIndex
CREATE INDEX "Reservation_status_ticketUploadDeadlineAt_idx" ON "public"."Reservation"("status", "ticketUploadDeadlineAt");

-- CreateIndex
CREATE INDEX "Reservation_refundStatus_idx" ON "public"."Reservation"("refundStatus");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizerApplication_userId_key" ON "public"."OrganizerApplication"("userId");

-- CreateIndex
CREATE INDEX "OrganizerApplication_status_idx" ON "public"."OrganizerApplication"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedAccount_userId_key" ON "public"."ConnectedAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedAccount_pspAccountId_key" ON "public"."ConnectedAccount"("pspAccountId");

-- CreateIndex
CREATE INDEX "ConnectedAccount_psp_pspAccountId_idx" ON "public"."ConnectedAccount"("psp", "pspAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_pspPayoutId_key" ON "public"."Payout"("pspPayoutId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_idempotencyKey_key" ON "public"."Payout"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payout_accountId_idx" ON "public"."Payout"("accountId");

-- CreateIndex
CREATE INDEX "Payout_status_updatedAt_idx" ON "public"."Payout"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "Payout_paymentId_idx" ON "public"."Payout"("paymentId");

-- CreateIndex
CREATE INDEX "Payout_source_idx" ON "public"."Payout"("source");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_reservationId_key" ON "public"."Payout"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_reservationId_key" ON "public"."Payment"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_token_key" ON "public"."Payment"("token");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_buyOrder_key" ON "public"."Payment"("buyOrder");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "public"."Payment"("status");

-- CreateIndex
CREATE INDEX "Payment_token_idx" ON "public"."Payment"("token");

-- CreateIndex
CREATE INDEX "Payment_buyOrder_idx" ON "public"."Payment"("buyOrder");

-- CreateIndex
CREATE INDEX "Payment_destinationAccountId_idx" ON "public"."Payment"("destinationAccountId");

-- CreateIndex
CREATE INDEX "Payment_psp_idx" ON "public"."Payment"("psp");

-- CreateIndex
CREATE INDEX "Payment_pspPaymentId_idx" ON "public"."Payment"("pspPaymentId");

-- CreateIndex
CREATE INDEX "Payment_escrowStatus_idx" ON "public"."Payment"("escrowStatus");

-- CreateIndex
CREATE INDEX "Payment_capturePolicy_idx" ON "public"."Payment"("capturePolicy");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_idx" ON "public"."LedgerEntry"("accountId");

-- CreateIndex
CREATE INDEX "LedgerEntry_paymentId_idx" ON "public"."LedgerEntry"("paymentId");

-- CreateIndex
CREATE INDEX "LedgerEntry_reservationId_idx" ON "public"."LedgerEntry"("reservationId");

-- CreateIndex
CREATE INDEX "LedgerEntry_payoutId_idx" ON "public"."LedgerEntry"("payoutId");

-- CreateIndex
CREATE INDEX "ResaleListing_eventId_idx" ON "public"."ResaleListing"("eventId");

-- CreateIndex
CREATE INDEX "ResaleListing_sellerId_idx" ON "public"."ResaleListing"("sellerId");

-- CreateIndex
CREATE INDEX "ResaleListing_status_idx" ON "public"."ResaleListing"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ResaleOrder_paymentId_key" ON "public"."ResaleOrder"("paymentId");

-- CreateIndex
CREATE INDEX "ResaleOrder_listingId_idx" ON "public"."ResaleOrder"("listingId");

-- CreateIndex
CREATE INDEX "ResaleOrder_buyerId_idx" ON "public"."ResaleOrder"("buyerId");

-- CreateIndex
CREATE INDEX "ResaleOrder_status_idx" ON "public"."ResaleOrder"("status");

-- CreateIndex
CREATE INDEX "TicketAsset_orderId_idx" ON "public"."TicketAsset"("orderId");

-- CreateIndex
CREATE INDEX "TicketAsset_uploaderId_idx" ON "public"."TicketAsset"("uploaderId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketAsset_sha256_key" ON "public"."TicketAsset"("sha256");

-- CreateIndex
CREATE INDEX "EscrowTimeline_orderId_idx" ON "public"."EscrowTimeline"("orderId");

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Reservation" ADD CONSTRAINT "Reservation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Reservation" ADD CONSTRAINT "Reservation_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Reservation" ADD CONSTRAINT "Reservation_approvedByAdminId_fkey" FOREIGN KEY ("approvedByAdminId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizerApplication" ADD CONSTRAINT "OrganizerApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ConnectedAccount" ADD CONSTRAINT "ConnectedAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Payout" ADD CONSTRAINT "Payout_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."ConnectedAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Payout" ADD CONSTRAINT "Payout_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "public"."Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Payout" ADD CONSTRAINT "Payout_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "public"."Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Payment" ADD CONSTRAINT "Payment_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "public"."Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Payment" ADD CONSTRAINT "Payment_destinationAccountId_fkey" FOREIGN KEY ("destinationAccountId") REFERENCES "public"."ConnectedAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LedgerEntry" ADD CONSTRAINT "LedgerEntry_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "public"."Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LedgerEntry" ADD CONSTRAINT "LedgerEntry_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "public"."Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LedgerEntry" ADD CONSTRAINT "LedgerEntry_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "public"."Payout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."ConnectedAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ResaleListing" ADD CONSTRAINT "ResaleListing_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ResaleListing" ADD CONSTRAINT "ResaleListing_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ResaleOrder" ADD CONSTRAINT "ResaleOrder_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "public"."ResaleListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ResaleOrder" ADD CONSTRAINT "ResaleOrder_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ResaleOrder" ADD CONSTRAINT "ResaleOrder_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "public"."Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TicketAsset" ADD CONSTRAINT "TicketAsset_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."ResaleOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TicketAsset" ADD CONSTRAINT "TicketAsset_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EscrowTimeline" ADD CONSTRAINT "EscrowTimeline_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."ResaleOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
