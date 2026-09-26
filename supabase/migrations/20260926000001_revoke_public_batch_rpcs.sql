-- SEC-02 follow-up: close the PUBLIC execute grant on the batch worker functions
--
-- 20260608000008 revoked EXECUTE from anon and authenticated, but in Postgres
-- every new function also gets EXECUTE granted to PUBLIC, and anon/authenticated
-- inherit from PUBLIC. So both roles could still call these SECURITY DEFINER
-- functions through /rest/v1/rpc with the public anon key:
--
--   claim_next_batch()  returns a message_batches row (incl. merged_text) from
--                       ANY workspace, bypassing RLS, and flips it to
--                       'processing' so the real worker skips it for 5 min.
--   cancel_batch(uuid)  cancels any in-flight batch by id.
--
-- Both are only meant to be called server-side with service_role
-- (src/features/inbox/services/buffer.ts), so revoke PUBLIC and grant
-- service_role explicitly. check_outbound_24h_window() is a trigger function
-- with the same leftover grants (PUBLIC, plus an explicit one to
-- authenticated); the trigger keeps firing without them. Guarded with
-- to_regprocedure so the migration is a no-op on older schemas where a
-- function does not exist yet.
--
-- Reported and first written by Gastón Persoglia (PR #7).

DO $$
BEGIN
  IF to_regprocedure('public.claim_next_batch()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.claim_next_batch() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.claim_next_batch() TO service_role;
  END IF;

  IF to_regprocedure('public.cancel_batch(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.cancel_batch(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.cancel_batch(uuid) TO service_role;
  END IF;

  IF to_regprocedure('public.check_outbound_24h_window()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.check_outbound_24h_window() FROM PUBLIC, anon, authenticated;
  END IF;
END
$$;

-- Verify after `supabase db push` (all must be false):
--   SELECT has_function_privilege('anon',          'public.claim_next_batch()',  'execute'),
--          has_function_privilege('authenticated', 'public.claim_next_batch()',  'execute'),
--          has_function_privilege('anon',          'public.cancel_batch(uuid)',  'execute'),
--          has_function_privilege('authenticated', 'public.cancel_batch(uuid)',  'execute'),
--          has_function_privilege('authenticated', 'public.check_outbound_24h_window()', 'execute');
