-- sum_daily_llm_tokens and upsert_batch_and_link_message are SECURITY INVOKER
-- and meant for service_role only. Their migrations revoke EXECUTE from PUBLIC,
-- but Supabase's default privileges grant EXECUTE directly to anon and
-- authenticated on every new function in public, and REVOKE ... FROM PUBLIC
-- does not remove those direct grants. RLS still applies (invoker), so this
-- closes an unintended surface rather than an exploitable hole.

REVOKE EXECUTE ON FUNCTION public.sum_daily_llm_tokens(uuid, timestamptz)
  FROM anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.upsert_batch_and_link_message(uuid, uuid, uuid, integer, boolean)
  FROM anon, authenticated;
