-- Adds 'kapso' to integration_provider.
--
-- Kapso replaces YCloud as the WhatsApp provider (YCloud is not available in the
-- United States). 'ycloud' is deliberately NOT removed: dropping a value from a
-- Postgres enum means recreating the type and rewriting every dependent column,
-- so the old value stays behind as a no-op.
--
-- This migration MUST stay alone in its own file. ALTER TYPE ... ADD VALUE cannot
-- be followed by a use of the new value inside the same transaction, and older
-- Postgres refuses it inside a transaction block entirely.

ALTER TYPE integration_provider ADD VALUE IF NOT EXISTS 'kapso';
