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
  getBooking,
  listMyBookings,
  listOrganizerBookings,
  cancelBooking,
  downloadTicket,
  listReservationTickets,
  downloadIndividualTicket,
  getGroupReservationTickets,
  // New endpoints (replace LEGACY tickets.controller)
  listMyTickets,
  getBookingStatus,
  refreshBookingPayment,
  refreshBookingTicket,
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

/** Obtener todas las reservaciones de un grupo de compra */
router.get("/group/:purchaseGroupId/tickets", authenticateToken, getGroupReservationTickets);

/** Obtener una reserva específica */
router.get("/:id", authenticateToken, getBooking);

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

/** Tickets individuales (OWN events) */
router.get("/:id/tickets", authenticateToken, listReservationTickets);
router.get("/:id/tickets/:ticketId/download", authenticateToken, downloadIndividualTicket);

/** Descargar ticket PDF (LEGACY - mantener compatibilidad) */
router.get("/:id/ticket", authenticateToken, downloadTicket);

/* ============================================================
 *  NEW ENDPOINTS - Reemplazan tickets.controller.ts LEGACY
 * ==========================================================*/

/** Listar todos los tickets del usuario (PAID reservations) */
router.get("/my-tickets", authenticateToken, listMyTickets);

/** Obtener estado de la reserva/ticket */
router.get("/:id/status", authenticateToken, getBookingStatus);

/** Refrescar estado del pago consultando PSP */
router.post("/:id/refresh-payment", authenticateToken, refreshBookingPayment);

/** Refrescar estado de generación del ticket */
router.post("/:id/refresh-ticket", authenticateToken, refreshBookingTicket);

export default router;






