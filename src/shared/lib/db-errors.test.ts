import assert from "node:assert/strict";
import { test } from "node:test";
import { isMissingFunctionError } from "./db-errors.ts";

test("a function PostgREST cannot find at all counts as missing", () => {
  assert.equal(
    isMissingFunctionError(
      { code: "PGRST202", hint: "Perhaps you meant to call the function public.reserve_workspace_llm_call" },
      "reserve_llm_turn",
    ),
    true,
  );
  assert.equal(isMissingFunctionError({ code: "PGRST202", hint: null }, "reserve_llm_turn"), true);
});

test("the same function with other parameter names is a bug, not a pending migration", () => {
  assert.equal(
    isMissingFunctionError(
      {
        code: "PGRST202",
        hint: "Perhaps you meant to call the function public.sum_daily_llm_tokens(p_day_start, p_workspace_id)",
      },
      "sum_daily_llm_tokens",
    ),
    false,
  );
});

test("42883 counts only when it names the function; other errors never do", () => {
  assert.equal(
    isMissingFunctionError(
      { code: "42883", message: "function public.reserve_llm_turn(uuid, text, integer) does not exist" },
      "reserve_llm_turn",
    ),
    true,
  );
  assert.equal(isMissingFunctionError({ code: "42883", message: "operator does not exist" }, "reserve_llm_turn"), false);
  assert.equal(isMissingFunctionError({ code: "57014", message: "canceling statement" }, "reserve_llm_turn"), false);
  assert.equal(isMissingFunctionError(null, "reserve_llm_turn"), false);
});
