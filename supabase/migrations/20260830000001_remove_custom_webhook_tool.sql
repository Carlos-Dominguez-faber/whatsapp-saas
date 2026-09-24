-- ============================================================
-- Migration: 20260830000001_remove_custom_webhook_tool
-- custom_webhook is retired: it was permanently blocked by
-- sensitivity = 'sensitive' (never executed) and replaced by the
-- per-workspace n8n_tools system. Its tool_configs rows cascade-delete
-- via the FK to tools.id.
-- ============================================================

DELETE FROM public.tools WHERE key = 'custom_webhook';
