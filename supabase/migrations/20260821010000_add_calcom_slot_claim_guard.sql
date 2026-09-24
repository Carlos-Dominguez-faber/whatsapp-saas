-- ============================================================
-- Migration: 20260821010000_add_calcom_slot_claim_guard
-- Agente WhatsApp — Cal.com scheduling integration
--
-- A purely application-level check-then-act idempotency guard in
-- schedule_calcom cannot prevent:
--   (a) two concurrent invocations for the same contact+slot both passing
--       the check before either has written a row, each then calling
--       Cal.com and creating two real remote bookings; and
--   (b) the guard misreporting success for a DIFFERENT service booked for
--       the same contact at the identical instant, since nothing recorded
--       which event type the existing row belonged to.
--
-- This migration adds the one thing application code cannot fake: a
-- database-enforced uniqueness constraint that makes claiming a slot
-- atomic. schedule_calcom now inserts its claim (calcom_booking_uid still
-- NULL) BEFORE calling Cal.com; a concurrent/retried claim for the same
-- slot fails with a unique_violation (23505) instead of silently
-- succeeding twice.
-- ============================================================

-- calcom_event_type_id lets schedule_calcom tell "the same request retried"
-- (same event_type_id) apart from "a different service already booked this
-- exact slot" (different event_type_id) when a claim conflicts.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS calcom_event_type_id INTEGER;

-- One active (booked/confirmed) Cal.com claim per workspace+contact+instant.
-- contact_id is coalesced to a sentinel so multiple no-contact claims (the
-- agent test-chat playground, which has no real contact) are still compared
-- against each other instead of every NULL being treated as distinct —
-- Postgres's default NULL semantics would otherwise let an unlimited number
-- of playground claims through for the identical slot.
--
-- Scoped to calcom_event_type_id IS NOT NULL (only rows schedule_calcom's
-- claim-then-book flow writes ever set this) so this constraint touches
-- ONLY Cal.com's own claim rows and can never conflict with a HighLevel
-- appointment — schedule_highlevel's local insert doesn't check for a
-- constraint violation, and widening this index to cover it too would
-- silently break that unrelated code path instead of fixing it.
-- Scoped to status IN ('booked','confirmed') so a cancelled slot frees up
-- for a new claim, matching the existing "active appointment" queries.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_calcom_slot_claim
  ON appointments (
    workspace_id,
    COALESCE(contact_id, '00000000-0000-0000-0000-000000000000'::uuid),
    scheduled_at
  )
  WHERE status IN ('booked', 'confirmed') AND calcom_event_type_id IS NOT NULL;

-- ============================================================
-- End of migration: 20260821010000_add_calcom_slot_claim_guard
-- ============================================================
