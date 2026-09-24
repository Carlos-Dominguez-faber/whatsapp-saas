-- Agrega 'hubspot' a integration_provider.
-- DEBE quedar sola en su archivo, igual que 20260731000000_integration_provider_add_kapso.sql:
-- ALTER TYPE ... ADD VALUE no puede ir seguido de un uso del valor nuevo en la misma transacción.

ALTER TYPE integration_provider ADD VALUE IF NOT EXISTS 'hubspot';
