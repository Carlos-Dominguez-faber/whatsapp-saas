-- ============================================================
-- Migration: 20260820010000_add_calcom_booking_uid_to_appointments
-- Agente WhatsApp — Cal.com scheduling integration
--
-- Mirrors hl_appointment_id: Cal.com identifies bookings by a string "uid"
-- (not a numeric id), stored as its own column so cancel/reschedule can do
-- the same indexed lookup by workspace_id + contact_id + status that
-- cancel-highlevel/reschedule-highlevel already use.
-- ============================================================

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS calcom_booking_uid TEXT;

-- ============================================================
-- End of migration: 20260820010000_add_calcom_booking_uid_to_appointments
-- ============================================================
