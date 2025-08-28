// src/routes/bookings.routes.ts
import { Router } from "express";
import {
  authenticateToken,
  authorizeRoles,
  requireVerifiedOrganizer,
} from "../middleware/authMiddleware";
import {
  holdReservation,
  payTestReservation,
  createBooking,            // opcional/backoffice
  listMyBookings,
  listOrganizerBookings,
  cancelBooking,
} from "../controllers/bookings.controller";

const router = Router();

/** HOLD (reserva temporal) */
router.post("/hold", authenticateToken, holdReservation);

/** Confirmación de pago (solo DEV / modo prueba)
 *  Requiere ALLOW_TEST_PAYMENTS != "false" en el .env
 */
router.post("/:id/pay-test", authenticateToken, payTestReservation);

/** (Opcional) Compra directa para backoffice/soporte */
router.post("/", authenticateToken, createBooking);

/** Mis reservas */
router.get("/my", authenticateToken, listMyBookings);

/** Reservas del organizador (sus eventos) o superadmin */
router.get(
  "/organizer",
  authenticateToken,
  authorizeRoles("organizer", "superadmin"),
  (req, res, next) => {
    // Si es superadmin, no exigimos verificación de organizer
    const user = (req as any).user as { id: number; role: string } | undefined;
    if (user?.role === "superadmin") return next();
    return requireVerifiedOrganizer(req, res, next);
  },
  listOrganizerBookings
);

/** Cancelar (dueño / organizer dueño / superadmin) */
router.post("/:id/cancel", authenticateToken, cancelBooking);

export default router;






