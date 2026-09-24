-- ============================================================
-- Migration: 20260824000001_sum_daily_llm_tokens
-- Agente WhatsApp — sumar el presupuesto diario de tokens en SQL
--
-- enforceCostPolicy() traía todas las filas llm_usage del día
-- (select("payload")) y sumaba tokens en Node con reduce() — sin
-- agregación SQL ni paginación. Al tope por defecto de PostgREST (1000
-- filas) la suma queda truncada. Reproducido: 1.001 eventos reales
-- sumando 1.500.499 tokens, la consulta trae 1000 filas y suma 1.499.000
-- — resultado "degrade" en vez de "cut" con el presupuesto ya reventado.
--
-- Esta función suma en Postgres (COALESCE(SUM(...), 0)) y devuelve un
-- escalar — un agregado no tiene límite de filas de PostgREST porque no
-- devuelve filas. SECURITY INVOKER (default, sin DEFINER): service_role ya
-- tiene acceso directo a events, no hace falta escalar privilegios acá —
-- evita reabrir en una función nueva el hueco del EXECUTE implícito de
-- PUBLIC sobre funciones SECURITY DEFINER. El
-- CASE WHEN preserva el comportamiento previo de "ignorar payloads
-- corruptos" (el reduce() de Node ya lo hacía con typeof t === "number")
-- en vez de que un ::bigint cast directo tire un error de SQL.
-- ============================================================

CREATE OR REPLACE FUNCTION public.sum_daily_llm_tokens(
  p_workspace_id UUID,
  p_day_start TIMESTAMPTZ
)
RETURNS BIGINT
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(SUM(
    CASE
      WHEN payload->>'total_tokens' ~ '^[0-9]+$'
      THEN (payload->>'total_tokens')::bigint
      ELSE 0
    END
  ), 0)
  FROM public.events
  WHERE type = 'llm_usage'
    AND workspace_id = p_workspace_id
    AND created_at >= p_day_start;
$$;

REVOKE ALL ON FUNCTION public.sum_daily_llm_tokens(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sum_daily_llm_tokens(uuid, timestamptz) TO service_role;

-- ============================================================
-- End of migration: 20260824000001_sum_daily_llm_tokens
-- ============================================================
