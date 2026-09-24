import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildZodSchema,
  sensitiveArgKeys,
  type N8nToolParameter,
} from "./n8n-params-schema.ts";

test("required string param must be present and rejects non-strings", () => {
  const schema = buildZodSchema([
    { key: "query", label: "Query", type: "string", required: true, description: "search text" },
  ]);
  assert.equal(schema.safeParse({}).success, false);
  assert.equal(schema.safeParse({ query: 5 }).success, false);
  assert.equal(schema.safeParse({ query: "hola" }).success, true);
});

test("optional field can be omitted", () => {
  const schema = buildZodSchema([
    { key: "note", label: "Nota", type: "string", required: false, description: "optional note" },
  ]);
  assert.equal(schema.safeParse({}).success, true);
  assert.equal(schema.safeParse({ note: "x" }).success, true);
});

test("number field rejects non-finite and non-numeric values", () => {
  const schema = buildZodSchema([
    { key: "qty", label: "Cantidad", type: "number", required: true, description: "quantity" },
  ]);
  assert.equal(schema.safeParse({ qty: 3 }).success, true);
  assert.equal(schema.safeParse({ qty: Infinity }).success, false);
  assert.equal(schema.safeParse({ qty: "3" }).success, false);
});

test("boolean field only accepts true/false", () => {
  const schema = buildZodSchema([
    { key: "urgent", label: "Urgente", type: "boolean", required: true, description: "is urgent" },
  ]);
  assert.equal(schema.safeParse({ urgent: true }).success, true);
  assert.equal(schema.safeParse({ urgent: "true" }).success, false);
});

test("enum field only accepts one of the configured options", () => {
  const schema = buildZodSchema([
    {
      key: "size",
      label: "Tamaño",
      type: "enum",
      required: true,
      description: "size",
      enum_options: ["S", "M", "L"],
    },
  ]);
  assert.equal(schema.safeParse({ size: "M" }).success, true);
  assert.equal(schema.safeParse({ size: "XL" }).success, false);
});

test("enum field with no options falls back to a plain string instead of throwing", () => {
  const schema = buildZodSchema([
    { key: "size", label: "Tamaño", type: "enum", required: true, description: "size" },
  ]);
  assert.equal(schema.safeParse({ size: "anything" }).success, true);
});

test("string field rejects a payload over the length cap", () => {
  const schema = buildZodSchema([
    { key: "text", label: "Texto", type: "string", required: true, description: "text" },
  ]);
  assert.equal(schema.safeParse({ text: "a".repeat(2000) }).success, true);
  assert.equal(schema.safeParse({ text: "a".repeat(2001) }).success, false);
});

test("sensitiveArgKeys returns only the keys flagged sensitive", () => {
  const params: N8nToolParameter[] = [
    { key: "note", label: "Nota", type: "string", required: false, description: "d" },
    {
      key: "codigo_cliente",
      label: "Código",
      type: "string",
      required: true,
      description: "d",
      sensitive: true,
    },
  ];
  assert.deepEqual(sensitiveArgKeys(params), ["codigo_cliente"]);
});
