/*
  Migration: payout_idem_backfill_fixed
  Objetivo:
    - Añadir columnas: externalStatus, idempotencyKey, retries.
    - Backfill de idempotencyKey para filas existentes.
    - Dejar idempotencyKey NOT NULL + UNIQUE.
    - Reemplazar índice por (status, updatedAt) para mejores consultas.
*/

-- 0) El índice viejo por status solo (si existía por @@index([status]))
DROP INDEX `Payout_status_idx` ON `Payout`;

-- 1) Agregar columnas de forma compatible (NULLables / con default)
ALTER TABLE `Payout`
  ADD COLUMN `externalStatus` VARCHAR(64) NULL,
  ADD COLUMN `idempotencyKey` VARCHAR(80) NULL,
  ADD COLUMN `retries` INT NOT NULL DEFAULT 0;

-- 2) Backfill para filas existentes (genera un valor único por fila)
UPDATE `Payout`
SET `idempotencyKey` = CONCAT('legacy_', REPLACE(UUID(), '-', ''))
WHERE `idempotencyKey` IS NULL;

-- 3) Volver idempotencyKey requerida y única
ALTER TABLE `Payout`
  MODIFY `idempotencyKey` VARCHAR(80) NOT NULL;

CREATE UNIQUE INDEX `Payout_idempotencyKey_key` ON `Payout`(`idempotencyKey`);

-- 4) Nuevo índice útil para consultas por estado/recientes
CREATE INDEX `Payout_status_updatedAt_idx` ON `Payout`(`status`, `updatedAt`);

-- 5) (Opcional, si garantizas un payout por reserva) Único por reserva
--    Ejecuta esto SOLO después de verificar que no hay duplicados:
--    SELECT reservationId, COUNT(*) c FROM Payout WHERE reservationId IS NOT NULL GROUP BY reservationId HAVING c > 1;
-- CREATE UNIQUE INDEX `Payout_reservationId_key` ON `Payout`(`reservationId`);


