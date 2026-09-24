-- ============================================================
-- Migration: 20260824000000_harden_security_definer_grants
-- Agente WhatsApp — revocar el EXECUTE implícito de PUBLIC
--
-- SEC-02 (20260608000008_sec02_function_hardening.sql) y la migración de
-- reserva de turno (20260823000000_llm_turn_reservation.sql) revocaron
-- EXECUTE de anon/authenticated en funciones internas de worker — pero
-- Postgres otorga EXECUTE a PUBLIC automáticamente al crear una función, y
-- todo rol (incluidos anon/authenticated) es miembro implícito de PUBLIC.
-- Revocar de los roles nombrados no quita el privilegio heredado de
-- PUBLIC: ambos grants coexisten y basta con que uno lo permita. Con la
-- anon key se puede invocar directamente el RPC SECURITY DEFINER,
-- insertar filas en events saltándose RLS, y potencialmente agotar el
-- cupo horario de un contacto ajeno o cancelar/reclamar batches ajenos.
--
-- Este REVOKE ALL FROM PUBLIC + GRANT explícito a service_role cierra el
-- hueco real (no dependía de que el grant amplio que Supabase le da a
-- service_role a nivel de proyecto siga existiendo en el futuro).
-- ============================================================

REVOKE ALL ON FUNCTION public.reserve_llm_turn(uuid, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_next_batch() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_batch(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_outbound_24h_window() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.reserve_llm_turn(uuid, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_next_batch() TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_batch(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.check_outbound_24h_window() TO service_role;

-- ============================================================
-- End of migration: 20260824000000_harden_security_definer_grants
-- ============================================================
