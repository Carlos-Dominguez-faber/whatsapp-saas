-- ============================================================
-- Migration: 20260907000000_seed_handoff_human_tool
-- Seed de la tool handoff_human en el catálogo
--
-- La tool está implementada y registrada en código
-- (src/features/tools/tools/handoff-human.ts → registry). El catálogo de
-- Settings lee public.tools y getEnabledTools() solo devuelve tools del
-- registry que tengan una fila enabled en tool_configs (que FK a tools), así
-- que sin este INSERT no se puede mostrar, activar ni ofrecer al agente.
--
-- Queda DESHABILITADA por defecto: no se crea ninguna fila en tool_configs,
-- cuyo `enabled` es DEFAULT FALSE. Se activa por workspace desde el panel.
--
-- La columna schema es solo para catálogo/display — el agente arma el schema
-- del LLM desde la definición zod del código — pero se mantiene fiel.
-- Idempotente vía ON CONFLICT, igual que el resto de los seeds de tools.
-- ============================================================

INSERT INTO public.tools (key, name, description, schema, sensitivity) VALUES
  ('handoff_human', 'Derivar a una persona',
   'Deja la conversación esperando a una persona del equipo, a pedido del cliente o cuando el agente no tiene con qué resolver',
   '{"type":"object","properties":{"reason":{"type":"string","enum":["customer_request","agent_stuck"]}},"required":["reason"]}',
   'write')
ON CONFLICT (key) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      schema = EXCLUDED.schema,
      sensitivity = EXCLUDED.sensitivity;

-- ============================================================
-- End of migration: 20260907000000_seed_handoff_human_tool
-- ============================================================
