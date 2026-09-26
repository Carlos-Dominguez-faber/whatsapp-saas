import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

type Row = Record<string, unknown>;
let rows: Row[] = [];

// Honors every filter the query uses — including or(), whose string is parsed
// — so a wrong filter in the code shows up as a wrong history here.
function orTest(expr: string): (r: Row) => boolean {
  const tests = expr.split(",").map((cond) => {
    const [col, op, ...rest] = cond.split(".");
    const value = rest.join(".");
    if (op === "is") return (r: Row) => r[col] == null;
    if (op === "neq") return (r: Row) => r[col] != null && String(r[col]) !== value;
    throw new Error(`unsupported or() operator ${op}`);
  });
  return (r) => tests.some((t) => t(r));
}

mock.module("@supabase/supabase-js", {
  exports: {
    createClient: () => ({
      from: () => ({
        select: () => {
          const filters: Array<(r: Row) => boolean> = [];
          let limit = Infinity;
          let desc = false;
          const q: any = {
            eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
            or: (expr: string) => (filters.push(orTest(expr)), q),
            lte: (c: string, v: string) => (filters.push((r) => String(r[c]) <= v), q),
            order: (_c: string, o: { ascending: boolean }) => ((desc = !o.ascending), q),
            limit: (n: number) => ((limit = n), q),
            then: (resolve: (v: unknown) => void) => {
              const hit = rows
                .filter((r) => filters.every((f) => f(r)))
                .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) * (desc ? -1 : 1))
                .slice(0, limit);
              resolve({ data: hit, error: null });
            },
          };
          return q;
        },
      }),
    }),
  },
});

const { getConversationHistory } = await import("./conversation-history.ts");

function msg(id: string, extra: Row): Row {
  return {
    id,
    conversation_id: "conv_1",
    workspace_id: "ws_1",
    type: "text",
    meta: {},
    status: "delivered",
    batch_id: null,
    ...extra,
  };
}

test("the history leaves out failed sends, the current batch, later messages and other workspaces", async () => {
  rows = [
    msg("m1", { direction: "in", body: "hola", created_at: "2026-09-26T10:00:00Z", batch_id: "b0" }),
    msg("m2", { direction: "out", body: "¡Hola! ¿En qué te ayudo?", created_at: "2026-09-26T10:00:10Z", status: "sent" }),
    msg("m3", { direction: "out", body: "respuesta que nunca llegó", created_at: "2026-09-26T10:01:00Z", status: "failed" }),
    msg("m4", { direction: "in", body: "quiero una cita", created_at: "2026-09-26T10:02:00Z", batch_id: "b1" }),
    msg("m5", { direction: "in", body: "y otra cosa después", created_at: "2026-09-26T10:05:00Z", batch_id: "b2" }),
    msg("m6", { direction: "in", body: "de otro workspace", created_at: "2026-09-26T10:00:30Z", workspace_id: "ws_2" }),
    msg("m7", { direction: "out", body: "nota interna", created_at: "2026-09-26T10:00:40Z", meta: { internal: true } }),
  ];
  const turns = await getConversationHistory("conv_1", {
    limit: 10,
    excludeBatchId: "b1",
    workspaceId: "ws_1",
    until: "2026-09-26T10:02:00Z",
  });
  assert.deepEqual(turns, [
    { role: "user", content: "hola" },
    { role: "assistant", content: "¡Hola! ¿En qué te ayudo?" },
  ]);
});
