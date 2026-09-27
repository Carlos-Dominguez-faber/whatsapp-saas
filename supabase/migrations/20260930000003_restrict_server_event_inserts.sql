-- ============================================================
-- Migration: 20260930000003_restrict_server_event_inserts
-- Agente WhatsApp — only the server writes events
--
-- 20260928000003 kept sessions from inserting the budget events, with a
-- denylist of types. A denylist is an exact match: a variant spelling
-- ('Member_Password_Reset', look-alike characters) slips past it, and every
-- new server-read type must remember to join it. The server reads events back
-- to audit, dedupe and cap (password resets, handoff acknowledgements and
-- team emails, the JEV quota, once-a-day alerts, the LLM budget), so a
-- session-written row can fake or silence any of those.
--
-- No session code inserts events: the app writes them with the service role,
-- and the database functions that write them are SECURITY DEFINER. So
-- sessions lose INSERT on the table outright, and the insert policy goes.
-- Reading is unchanged (events_select). Idempotent.
-- ============================================================

DROP POLICY IF EXISTS "events_insert" ON public.events;
REVOKE INSERT ON public.events FROM PUBLIC, anon, authenticated;

-- ============================================================
-- End of migration: 20260930000003_restrict_server_event_inserts
-- ============================================================
