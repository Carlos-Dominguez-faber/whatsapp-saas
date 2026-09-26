import assert from "node:assert/strict";
import { test, mock } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";

let storedMeta: Record<string, unknown> | null = null;
let readError: { message: string } | null = null;
const writes: unknown[] = [];

const fakeClient = {
  from: () => ({
    select: () => {
      const chain: any = {
        eq: () => chain,
        maybeSingle: async () => ({
          data: readError ? null : { meta: storedMeta },
          error: readError,
        }),
      };
      return chain;
    },
    update: (row: unknown) => {
      writes.push(row);
      const chain: any = {
        eq: () => chain,
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
      };
      return chain;
    },
  }),
};
mock.module("@supabase/supabase-js", {
  exports: { createClient: () => fakeClient },
});

const { patchMessageMedia } = await import("./media-handler.ts");

const media = { storage_path: "ws/msg.jpg", mime: "image/jpeg" } as never;

test("the media patch keeps what the normalizer already stored in meta", async () => {
  storedMeta = { from_name: "Ana", origin: "cloud_api" };
  readError = null;
  writes.length = 0;
  await patchMessageMedia("ws_1", "msg_1", media);
  assert.deepEqual((writes[0] as { meta: unknown }).meta, {
    from_name: "Ana",
    origin: "cloud_api",
    storage_path: "ws/msg.jpg",
    mime: "image/jpeg",
  });
});

test("if the current meta can't be read, nothing is overwritten", async () => {
  readError = { message: "timeout" };
  writes.length = 0;
  const original = console.error;
  console.error = () => {};
  try {
    await patchMessageMedia("ws_1", "msg_1", media);
  } finally {
    console.error = original;
  }
  assert.equal(writes.length, 0);
});
