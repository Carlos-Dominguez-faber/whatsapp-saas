-- ============================================================
-- Migration: 20260824000002_revoke_authenticated_check_outbound_24h_window
-- Agente WhatsApp — revoke authenticated's direct EXECUTE grant
--
-- get_advisors kept flagging check_outbound_24h_window as executable by
-- `authenticated` even after 20260824000000's REVOKE ALL FROM PUBLIC.
-- Root cause, confirmed by inspecting pg_proc.proacl directly: this
-- function carries an EXPLICIT grant to `authenticated` (Supabase's
-- default-privileges grant at function-creation time) that is separate
-- from — and not touched by — a PUBLIC revoke. SEC-02
-- (20260608000008_sec02_function_hardening.sql) only revoked EXECUTE from
-- `anon` for this one function, never from `authenticated` — the other 3
-- functions in that same migration revoked from both roles, so this was a
-- one-function oversight in SEC-02, not something introduced today.
--
-- check_outbound_24h_window() is a trigger function (24h outbound guard);
-- it has no legitimate reason to be invocable directly via
-- /rest/v1/rpc/check_outbound_24h_window by a signed-in app user.
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.check_outbound_24h_window() FROM authenticated;

-- ============================================================
-- End of migration: 20260824000002_revoke_authenticated_check_outbound_24h_window
-- ============================================================
