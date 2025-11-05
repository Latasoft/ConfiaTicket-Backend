-- CreateTable
CREATE TABLE "public"."ReservationHoldConfig" (
    "id" SERIAL NOT NULL,
    "holdMinutes" INTEGER NOT NULL DEFAULT 15,
    "description" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReservationHoldConfig_pkey" PRIMARY KEY ("id")
);
