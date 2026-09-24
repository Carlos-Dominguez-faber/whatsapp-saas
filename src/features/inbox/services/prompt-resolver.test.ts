import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

// `selects` guarda el string que cada `.select()` recibió, para poder afirmar
// sobre el embed. `eqs` guarda los pares [col, val] de cada filtro: sin eso,
// borrar el `.eq("workspace_id", …)` solo rompería el test por accidente.
// `result` es lo que resuelve la consulta.
const selects: string[] = [];
const eqs: unknown[][] = [];
let result: { data: unknown; error: unknown } = { data: [], error: null };

const fakeClient = {
  from: () => ({
    select: (cols: string) => {
      selects.push(cols);
      return {
        eq: (col: string, val: unknown) => {
          eqs.push([col, val]);
          return { order: async () => result };
        },
      };
    },
  }),
};

mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

const { listPrompts } = await import("./prompt-resolver.ts");

test("listPrompts embebe prompt_versions con hint de relación", async () => {
  selects.length = 0;
  eqs.length = 0;
  result = { data: [], error: null };

  await listPrompts("ws_1");

  assert.equal(selects.length, 1);
  const select = selects[0];

  // Hay dos FK entre `prompts` y `prompt_versions`, así que un embed sin hint
  // hace que PostgREST responda PGRST201 y la consulta falle entera. El hint
  // tiene que apuntar a la relación padre→hijo (`prompt_versions.prompt_id`),
  // no a `active_version_id`, que devolvería solo la versión activa.
  assert.match(
    select,
    /prompt_versions!prompt_id\s*\(/,
    `el embed de prompt_versions perdió el hint de relación: ${select}`,
  );
  assert.doesNotMatch(select, /prompt_versions!active_version_id/);
});

test("listPrompts filtra por workspace_id", async () => {
  selects.length = 0;
  eqs.length = 0;
  result = { data: [], error: null };

  await listPrompts("ws_1");

  // Corre con `service_role` (sin RLS): el filtro de tenant tiene que estar
  // acá adentro o la consulta devuelve los prompts de todos los workspaces.
  assert.deepEqual(eqs, [["workspace_id", "ws_1"]]);
});

test("listPrompts propaga el error de la consulta", async () => {
  selects.length = 0;
  result = { data: null, error: { message: "boom" } };

  await assert.rejects(
    () => listPrompts("ws_1"),
    /listPrompts error: boom/,
    "un error de PostgREST tiene que lanzar, no devolver lista vacía",
  );
});

test("listPrompts devuelve lista vacía cuando no hay filas", async () => {
  selects.length = 0;
  result = { data: null, error: null };

  assert.deepEqual(await listPrompts("ws_1"), []);
});
