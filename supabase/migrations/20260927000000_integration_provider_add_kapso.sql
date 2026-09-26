-- ============================================================
-- Migration: 20260927000000_integration_provider_add_kapso
-- Agente WhatsApp — Kapso joins YCloud as a WhatsApp provider on main
--
-- Each workspace picks its provider (YCloud or Kapso — Kapso works in the
-- United States, YCloud does not). This only adds the enum value.
--
-- It MUST stay alone in its own file: ALTER TYPE ... ADD VALUE cannot be
-- followed by a use of the new value inside the same transaction. Installs
-- coming from the old provider/kapso branch already have the value (their
-- 20260731000000 migration); IF NOT EXISTS makes this a no-op there.
-- ============================================================

ALTER TYPE public.integration_provider ADD VALUE IF NOT EXISTS 'kapso';
